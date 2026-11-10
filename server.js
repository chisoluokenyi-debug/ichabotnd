require("dotenv").config();
const express=require("express"),axios=require("axios"),path=require("path"),crypto=require("crypto"),session=require("express-session"),PgSession=require("connect-pg-simple")(session),helmet=require("helmet"),{Pool}=require("pg");
const app=express(),PORT=process.env.PORT||3000;
const GRAPH_VERSION=(process.env.META_GRAPH_VERSION||"v25.0").replace(/^\/?/,"v").replace(/^vv/,"v"),GRAPH_BASE="https://graph.facebook.com/"+GRAPH_VERSION;
const LEGACY_PAGE_ID=String(process.env.PAGE_ID||"").trim(),LEGACY_PAGE_TOKEN=String(process.env.PAGE_ACCESS_TOKEN||"").trim(),LEGACY_PAGE_NAME=String(process.env.PAGE_NAME||"Connected Facebook Page").trim();
function configuredPageCredentials(){
 const pages=[];
 if(LEGACY_PAGE_ID&&LEGACY_PAGE_TOKEN)pages.push({id:LEGACY_PAGE_ID,token:LEGACY_PAGE_TOKEN,name:LEGACY_PAGE_NAME});
 for(const key of Object.keys(process.env)){
  const m=key.match(/^PAGE_(\d+)_ID$/);
  if(!m)continue;
  const n=m[1],id=String(process.env[key]||"").trim(),token=String(process.env["PAGE_"+n+"_ACCESS_TOKEN"]||"").trim(),name=String(process.env["PAGE_"+n+"_NAME"]||("Facebook Page "+n)).trim();
  if(id&&token&&!pages.some(p=>p.id===id))pages.push({id,token,name});
 }
 return pages;
}
const APP_SECRET=process.env.META_APP_SECRET||"",VERIFY_TOKEN=process.env.META_WEBHOOK_VERIFY_TOKEN||"",ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"",SESSION_SECRET=process.env.SESSION_SECRET||"",META_APP_ID=String(process.env.META_APP_ID||"").trim(),FACEBOOK_ADMIN_ID=String(process.env.FACEBOOK_ADMIN_ID||"").trim();
const APP_BASE_URL=(process.env.APP_BASE_URL||process.env.RENDER_EXTERNAL_URL||"https://ichabotnd.onrender.com").replace(/\/+$/,"");
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is missing.");
if(SESSION_SECRET.length<32)throw new Error("SESSION_SECRET must be at least 32 characters.");
if(!APP_SECRET)console.warn("META_APP_SECRET is not configured.");
if(!VERIFY_TOKEN)console.warn("META_WEBHOOK_VERIFY_TOKEN is not configured.");
if(!ADMIN_PASSWORD)console.warn("ADMIN_PASSWORD is not configured; dashboard login will remain locked.");
if(!configuredPageCredentials().length)console.warn("No Page credentials found in Render Environment; add PAGE_1_ID and PAGE_1_ACCESS_TOKEN or connect a Page in the dashboard.");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="true"?{rejectUnauthorized:false}:undefined});
function personalizeMessage(message,names={}){const first=String(names.first_name||"").trim(),middle=String(names.middle_name||"").trim(),last=String(names.last_name||"").trim(),full=String(names.full_name||[first,middle,last].filter(Boolean).join(" ")).trim();return String(message||"").replace(/\{\s*(first_name|middle_name|last_name|full_name)\s*\}/gi,(_,key)=>({first_name:first,middle_name:middle,last_name:last,full_name:full}[key.toLowerCase()]||""));}
pool.on("error",e=>console.error("Database error:",e.message));
const safeEqual=(a,b)=>{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
app.set("trust proxy",1);app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"1mb",verify:(req,res,b)=>{if(req.path==="/webhook")req.rawBody=Buffer.from(b);}}));
app.use(express.urlencoded({extended:true}));
app.use(session({store:new PgSession({pool,tableName:"user_sessions",createTableIfMissing:true}),secret:SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}}));
app.use(express.static(path.join(__dirname,"public")));
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const requireAdmin=(req,res,next)=>req.session.adminAuthenticated?next():res.status(401).json({error:"Please sign in to the IchaBot dashboard."});
const facebookLoginReady=()=>Boolean(META_APP_ID&&APP_SECRET&&FACEBOOK_ADMIN_ID);
const tokenKey=()=>crypto.createHash("sha256").update("ichabot-facebook-pages:"+SESSION_SECRET).digest();
function encryptToken(token){const iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",tokenKey(),iv),data=Buffer.concat([c.update(String(token),"utf8"),c.final()]);return [iv.toString("base64"),c.getAuthTag().toString("base64"),data.toString("base64")].join(".");}
function decryptToken(value){const [iv,tag,data]=String(value||"").split(".");if(!iv||!tag||!data)throw new Error("Stored Page token is invalid.");const d=crypto.createDecipheriv("aes-256-gcm",tokenKey(),Buffer.from(iv,"base64"));d.setAuthTag(Buffer.from(tag,"base64"));return Buffer.concat([d.update(Buffer.from(data,"base64")),d.final()]).toString("utf8");}
async function getPage(id){if(!id)return null;const r=await pool.query("SELECT page_id,page_name,access_token_encrypted FROM facebook_pages WHERE page_id=$1 AND active=TRUE",[String(id)]);if(!r.rowCount)return null;return{page_id:r.rows[0].page_id,page_name:r.rows[0].page_name,accessToken:decryptToken(r.rows[0].access_token_encrypted)};}
async function getPages(){return(await pool.query("SELECT page_id,page_name,created_at FROM facebook_pages WHERE active=TRUE ORDER BY created_at")).rows;}
async function pageFor(req){const id=String(req.query.pageId||req.body?.pageId||"").trim();if(id){const p=await getPage(id);if(!p)throw Object.assign(new Error("Selected Facebook Page is not connected."),{status:404});return p;}const pages=await getPages();return pages.length?getPage(pages[0].page_id):null;}
const pageReady=p=>Boolean(p&&p.page_id&&p.accessToken);
async function graphPost(page,endpoint,data){const r=await axios.post(GRAPH_BASE+"/"+endpoint,data,{params:{access_token:page.accessToken},timeout:20000});return r.data;}
async function initDatabase(){
 await pool.query(`CREATE TABLE IF NOT EXISTS facebook_pages(page_id TEXT PRIMARY KEY,page_name TEXT NOT NULL,access_token_encrypted TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
 for(const configured of configuredPageCredentials()){
  try{
   const p=await axios.get(GRAPH_BASE+"/me",{params:{fields:"id,name",access_token:configured.token},timeout:15000});
   if(String(p.data.id)!==configured.id)throw new Error("The configured Page ID does not match this Page access token (token resolves to "+String(p.data.id||"unknown") + ").");
   await pool.query(`INSERT INTO facebook_pages(page_id,page_name,access_token_encrypted) VALUES($1,$2,$3) ON CONFLICT(page_id) DO UPDATE SET page_name=EXCLUDED.page_name,access_token_encrypted=EXCLUDED.access_token_encrypted,active=TRUE,updated_at=NOW()`,[configured.id,String(p.data.name||configured.name),encryptToken(configured.token)]);
   console.log("Imported Render Page credentials:",configured.id);
   try{
    await axios.post(GRAPH_BASE+"/"+configured.id+"/subscribed_apps",{}, {params:{subscribed_fields:"messages,messaging_postbacks,feed",access_token:configured.token},timeout:15000});
    console.log("Subscribed IchaBot to Page webhooks:",configured.id);
   }catch(subscriptionError){
    console.error("Page imported but webhook subscription failed for "+configured.id+":",subscriptionError.response?.data?.error?.message||subscriptionError.message);
   }
  }catch(e){console.error("Could not import Render Page credentials for "+configured.id+":",e.response?.data?.error?.message||e.message);}
 }
 await pool.query(`CREATE TABLE IF NOT EXISTS settings(page_id TEXT PRIMARY KEY,welcome_enabled BOOLEAN NOT NULL DEFAULT TRUE,welcome_message TEXT NOT NULL DEFAULT 'Hello! Thanks for messaging us. How can we help you today?',default_enabled BOOLEAN NOT NULL DEFAULT TRUE,default_reply TEXT NOT NULL DEFAULT 'Thanks for your message. We will get back to you shortly.',comment_enabled BOOLEAN NOT NULL DEFAULT TRUE,comment_reply TEXT NOT NULL DEFAULT 'Thanks for your comment! We have sent you a private message.',updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await pool.query(`CREATE TABLE IF NOT EXISTS saved_messages(id BIGSERIAL PRIMARY KEY,page_id TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS saved_messages_page_idx ON saved_messages(page_id,updated_at DESC)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS contacts(page_id TEXT NOT NULL,psid TEXT NOT NULL,last_interaction TIMESTAMPTZ DEFAULT NOW(),first_message BOOLEAN NOT NULL DEFAULT TRUE,welcome_claimed_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(page_id,psid))`);
 await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_message BOOLEAN NOT NULL DEFAULT TRUE`);
 await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS welcome_claimed_at TIMESTAMPTZ`);
 await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name TEXT`);
 await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS middle_name TEXT`);
 await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name TEXT`);
 await pool.query(`CREATE TABLE IF NOT EXISTS broadcasts(id BIGSERIAL PRIMARY KEY,page_id TEXT NOT NULL,message TEXT NOT NULL,scheduled_at TIMESTAMPTZ,status TEXT NOT NULL DEFAULT 'scheduled',sent_count INTEGER NOT NULL DEFAULT 0,failed_count INTEGER NOT NULL DEFAULT 0,eligible_count INTEGER NOT NULL DEFAULT 0,locked_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
 await pool.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS eligible_count INTEGER NOT NULL DEFAULT 0`);
 await pool.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
 await pool.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0`);
 await pool.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0`);
 await pool.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`);
 await pool.query(`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
 await pool.query(`CREATE TABLE IF NOT EXISTS processed_events(event_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'processing',created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS contacts_activity_idx ON contacts(page_id,last_interaction)`);
 await pool.query(`CREATE INDEX IF NOT EXISTS broadcasts_due_idx ON broadcasts(status,scheduled_at)`);
 console.log("Multi-Page database is ready.");
 console.log("IchaBot database is ready.");
}
async function getSettings(pageId){if(!pageId)return null;await pool.query(`INSERT INTO settings(page_id) VALUES($1) ON CONFLICT(page_id) DO NOTHING`,[pageId]);return(await pool.query(`SELECT * FROM settings WHERE page_id=$1`,[pageId])).rows[0];}
async function sendMessage(page,psid,message){if(!pageReady(page))throw new Error("Facebook Page connection is not configured.");const r=await pool.query("SELECT first_name,middle_name,last_name FROM contacts WHERE page_id=$1 AND psid=$2",[page.page_id,String(psid)]),n=r.rows[0]||{},full=[n.first_name,n.middle_name,n.last_name].filter(Boolean).join(" ");let body=String(message||"");const match=body.match(/\[\[ICHABOT_URL_BUTTON:([^|\]]+)\|(https?:\/\/[^\s\]]+)\]\]/i);if(match){let label="";try{label=decodeURIComponent(match[1]);}catch{}body=body.replace(match[0],(label?label+": ":"")+match[2]).trim();}return graphPost(page,page.page_id+"/messages",{recipient:{id:psid},messaging_type:"RESPONSE",message:{text:personalizeMessage(body,{...n,full_name:full})}});}
async function claimEvent(id){const r=await pool.query(`INSERT INTO processed_events(event_id,status,updated_at) VALUES($1,'processing',NOW()) ON CONFLICT(event_id) DO UPDATE SET status='processing',updated_at=NOW() WHERE processed_events.status='failed' OR (processed_events.status='processing' AND processed_events.updated_at<NOW()-INTERVAL '5 minutes') RETURNING event_id`,[id]);return r.rowCount>0;}
async function finishEvent(id,ok){await pool.query(`UPDATE processed_events SET status=$2,updated_at=NOW() WHERE event_id=$1`,[id,ok?"processed":"failed"]);}
async function processMessage(event,page){
 if(!event.sender?.id||event.message?.is_echo||!pageReady(page))return;
 const pageId=page.page_id,psid=String(event.sender.id),mid=event.message?.mid,eventId=mid?"message:"+pageId+":"+mid:null;
 if(eventId&&!(await claimEvent(eventId)))return;
 try{const settings=await getSettings(pageId);
  await pool.query(`INSERT INTO contacts(page_id,psid,last_interaction,first_message) VALUES($1,$2,NOW(),TRUE) ON CONFLICT(page_id,psid) DO UPDATE SET last_interaction=NOW()`,[pageId,psid]);
  try{const profile=await axios.get(GRAPH_BASE+"/"+psid,{params:{fields:"first_name,last_name",access_token:page.accessToken},timeout:12000});await pool.query("UPDATE contacts SET first_name=COALESCE(NULLIF($1,''),first_name),last_name=COALESCE(NULLIF($2,''),last_name) WHERE page_id=$3 AND psid=$4",[String(profile.data.first_name||""),String(profile.data.last_name||""),pageId,psid]);}catch(e){const x=e.response?.data?.error||{};console.warn("Messenger profile lookup failed:",{status:e.response?.status||null,code:x.code||null,message:x.message||e.message});}
  const c=await pool.query(`UPDATE contacts SET welcome_claimed_at=NOW() WHERE page_id=$1 AND psid=$2 AND first_message=TRUE AND (welcome_claimed_at IS NULL OR welcome_claimed_at<NOW()-INTERVAL '5 minutes') RETURNING psid`,[pageId,psid]),first=c.rowCount>0,reply=first&&settings.welcome_enabled?settings.welcome_message:(settings.default_enabled?settings.default_reply:"");
  if(reply){try{await sendMessage(page,psid,reply);if(first)await pool.query(`UPDATE contacts SET first_message=FALSE,welcome_claimed_at=NULL WHERE page_id=$1 AND psid=$2`,[pageId,psid]);}catch(e){if(first)await pool.query(`UPDATE contacts SET welcome_claimed_at=NULL WHERE page_id=$1 AND psid=$2`,[pageId,psid]);throw e;}}
  else if(first)await pool.query(`UPDATE contacts SET first_message=FALSE,welcome_claimed_at=NULL WHERE page_id=$1 AND psid=$2`,[pageId,psid]);
  if(eventId)await finishEvent(eventId,true);
 }catch(e){if(eventId)await finishEvent(eventId,false);throw e;}
}
async function processComment(v,page){if(!pageReady(page)||!v||v.item!=="comment"||v.verb!=="add")return;const id=String(v.comment_id||v.id||"");if(!id||(v.from&&String(v.from.id)===page.page_id))return;const eventId="comment:"+page.page_id+":"+id;if(!(await claimEvent(eventId)))return;try{const settings=await getSettings(page.page_id);if(!settings||!settings.comment_enabled){await finishEvent(eventId,true);return;}let replyOk=!settings.comment_reply;try{await graphPost(page,id+"/likes",{});}catch(e){console.error("Comment like failed:",e.response?.data||e.message);}if(settings.comment_reply){try{const name=String(v.from?.name||"").trim();await graphPost(page,id+"/private_replies",{message:personalizeMessage(settings.comment_reply,{first_name:name.split(/\\s+/)[0]||"",full_name:name})});replyOk=true;}catch(e){console.error("Comment reply failed:",e.response?.data||e.message);}}await finishEvent(eventId,replyOk);}catch(e){await finishEvent(eventId,false);throw e;}}
async function processPayload(payload){for(const entry of(Array.isArray(payload?.entry)?payload.entry:[])){const page=await getPage(String(entry.id||""));if(!page){console.warn("Webhook Page not connected:",String(entry.id||""));continue;}for(const event of entry.messaging||[]){try{await processMessage(event,page);}catch(e){console.error("Messenger event failed:",e.response?.data||e.message);}}for(const change of entry.changes||[]){if(change.field==="feed")try{await processComment(change.value,page);}catch(e){console.error("Comment event failed:",e.response?.data||e.message);}}}}
app.get("/auth/facebook",(req,res)=>{
 if(!facebookLoginReady())return res.status(503).send("Facebook Login is not configured. Add META_APP_ID and FACEBOOK_ADMIN_ID in Render Environment.");
 const state=crypto.randomBytes(32).toString("hex");
 req.session.facebookOAuthState=state;
 req.session.save(err=>{
  if(err)return res.status(500).send("Could not start Facebook Login.");
  const redirectUri=APP_BASE_URL+"/auth/facebook/callback";
  const params=new URLSearchParams({client_id:META_APP_ID,redirect_uri:redirectUri,state,response_type:"code"});
  res.redirect("https://www.facebook.com/"+GRAPH_VERSION+"/dialog/oauth?"+params.toString());
 });
});
app.get("/auth/facebook/callback",asyncRoute(async(req,res)=>{
 const state=String(req.query.state||"");
 const expected=String(req.session.facebookOAuthState||"");
 delete req.session.facebookOAuthState;
 if(!expected||!safeEqual(state,expected))return res.status(400).send("Facebook Login could not be verified. Please try again.");
 if(req.query.error)return res.redirect("/?facebook_login_error=cancelled");
 const code=String(req.query.code||"");
 if(!code)return res.status(400).send("Facebook did not return a login code.");
 const redirectUri=APP_BASE_URL+"/auth/facebook/callback";
 const token=await axios.get("https://graph.facebook.com/"+GRAPH_VERSION+"/oauth/access_token",{params:{client_id:META_APP_ID,client_secret:APP_SECRET,redirect_uri:redirectUri,code},timeout:20000});
 const profile=await axios.get("https://graph.facebook.com/"+GRAPH_VERSION+"/me",{params:{fields:"id",access_token:token.data.access_token},timeout:20000});
 const facebookId=String(profile.data.id||"");
 if(!facebookId||facebookId!==FACEBOOK_ADMIN_ID)return res.status(403).send("This Facebook account is not authorized to access the IchaBot dashboard.");
 req.session.regenerate(err=>{
  if(err)return res.status(500).send("Could not start secure session.");
  req.session.adminAuthenticated=true;
  req.session.facebookUserId=facebookId;
  req.session.save(e=>e?res.status(500).send("Could not save your login session."):res.redirect("/"));
 });
}));
app.post("/api/login",(req,res)=>{
 if(!ADMIN_PASSWORD)return res.status(503).json({error:"ADMIN_PASSWORD must be added to Render Environment before sign-in."});
 if(!safeEqual(req.body.password,ADMIN_PASSWORD))return res.status(401).json({error:"Incorrect dashboard password."});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:"Could not start secure session."});req.session.adminAuthenticated=true;req.session.save(e=>e?res.status(500).json({error:"Could not save session."}):res.json({success:true}));});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.get("/api/me",asyncRoute(async(req,res)=>{const pages=await getPages();res.json({authenticated:!!req.session.adminAuthenticated,pageConnected:pages.length>0,pages:pages.map(p=>({pageId:p.page_id,pageName:p.page_name})),pageName:pages[0]?.page_name||null,pageId:pages[0]?.page_id||null,facebookLoginEnabled:facebookLoginReady(),needsSetup:!ADMIN_PASSWORD||!APP_SECRET||!VERIFY_TOKEN});}));
app.get("/api/pages",requireAdmin,asyncRoute(async(req,res)=>res.json(await getPages())));
app.post("/api/pages",requireAdmin,asyncRoute(async(req,res)=>{const pageId=String(req.body.pageId||"").trim(),accessToken=String(req.body.accessToken||"").trim();if(!pageId||!accessToken)return res.status(400).json({error:"Enter the Page ID and Page access token."});if(pageId.length>100||accessToken.length>10000)return res.status(400).json({error:"Invalid Page details."});const p=await axios.get(GRAPH_BASE+"/me",{params:{fields:"id,name",access_token:accessToken},timeout:20000});if(String(p.data.id)!==pageId)return res.status(400).json({error:"This token belongs to a different Page ID."});await axios.post(GRAPH_BASE+"/"+pageId+"/subscribed_apps",{}, {params:{subscribed_fields:"messages,messaging_postbacks,feed",access_token},timeout:20000});const name=String(p.data.name||"Facebook Page");await pool.query(`INSERT INTO facebook_pages(page_id,page_name,access_token_encrypted) VALUES($1,$2,$3) ON CONFLICT(page_id) DO UPDATE SET page_name=EXCLUDED.page_name,access_token_encrypted=EXCLUDED.access_token_encrypted,active=TRUE,updated_at=NOW()`,[pageId,name,encryptToken(accessToken)]);await pool.query("INSERT INTO settings(page_id) VALUES($1) ON CONFLICT(page_id) DO NOTHING",[pageId]);res.status(201).json({success:true,message:"Facebook Page connected.",page:{pageId,pageName:name}});}));
app.delete("/api/pages/:id",requireAdmin,asyncRoute(async(req,res)=>{const id=String(req.params.id||""),count=await pool.query("SELECT COUNT(*)::int AS n FROM facebook_pages WHERE active=TRUE");if(count.rows[0].n<=1)return res.status(400).json({error:"Keep at least one Page connected."});const r=await pool.query("UPDATE facebook_pages SET active=FALSE,updated_at=NOW() WHERE page_id=$1 RETURNING page_id",[id]);if(!r.rowCount)return res.status(404).json({error:"Page not found."});res.json({success:true});}));
app.get("/api/audience",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!p)return res.status(503).json({error:"Connect a Page first."});const r=await pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE last_interaction>NOW()-INTERVAL '24 hours')::int AS eligible FROM contacts WHERE page_id=$1`,[p.page_id]);res.json({total:Number(r.rows[0].total||0),eligible:Number(r.rows[0].eligible||0),windowHours:24});}));
app.get("/api/saved-messages",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!p)return res.status(503).json({error:"Connect a Page first."});const r=await pool.query(`SELECT id,title,message,created_at,updated_at FROM saved_messages WHERE page_id=$1 ORDER BY updated_at DESC,id DESC`,[p.page_id]);res.json(r.rows);}));
app.post("/api/saved-messages",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!p)return res.status(503).json({error:"Connect a Page first."});const title=String(req.body.title||"").trim(),message=String(req.body.message||"").trim(),id=Number(req.body.id||0);if(!title||!message)return res.status(400).json({error:"Enter a title and message."});if(title.length>80||message.length>2000)return res.status(400).json({error:"Title or message is too long."});if(id>0){const r=await pool.query(`UPDATE saved_messages SET title=$1,message=$2,updated_at=NOW() WHERE id=$3 AND page_id=$4 RETURNING id,title,message,created_at,updated_at`,[title,message,id,p.page_id]);if(!r.rowCount)return res.status(404).json({error:"Saved message not found."});return res.json({success:true,message:"Saved message updated.",savedMessage:r.rows[0]});}const r=await pool.query(`INSERT INTO saved_messages(page_id,title,message) VALUES($1,$2,$3) RETURNING id,title,message,created_at,updated_at`,[p.page_id,title,message]);res.status(201).json({success:true,message:"Saved message created.",savedMessage:r.rows[0]});}));
app.delete("/api/saved-messages/:id",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!p)return res.status(503).json({error:"Connect a Page first."});const r=await pool.query("DELETE FROM saved_messages WHERE id=$1 AND page_id=$2 RETURNING id",[Number(req.params.id),p.page_id]);if(!r.rowCount)return res.status(404).json({error:"Saved message not found."});res.json({success:true});}));
app.get("/api/settings",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!p)return res.status(503).json({error:"Connect a Page first."});res.json(await getSettings(p.page_id));}));
app.post("/api/settings",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!p)return res.status(503).json({error:"Connect a Page first."});const w=String(req.body.welcome_message||"").trim(),d=String(req.body.default_reply||"").trim(),c=String(req.body.comment_reply||"").trim();if([w,d,c].some(x=>x.length>2000))return res.status(400).json({error:"Replies must be 2,000 characters or less."});await pool.query(`INSERT INTO settings(page_id,welcome_enabled,welcome_message,default_enabled,default_reply,comment_enabled,comment_reply,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(page_id) DO UPDATE SET welcome_enabled=EXCLUDED.welcome_enabled,welcome_message=EXCLUDED.welcome_message,default_enabled=EXCLUDED.default_enabled,default_reply=EXCLUDED.default_reply,comment_enabled=EXCLUDED.comment_enabled,comment_reply=EXCLUDED.comment_reply,updated_at=NOW()`,[p.page_id,req.body.welcome_enabled===true,w,req.body.default_enabled===true,d,req.body.comment_enabled===true,c]);res.json({success:true,message:"Settings saved."});}));
async function sendBroadcast(job,page){const r=await pool.query(`SELECT psid FROM contacts WHERE page_id=$1 AND last_interaction>NOW()-INTERVAL '24 hours' ORDER BY last_interaction DESC LIMIT 5000`,[page.page_id]);let sent=0,failed=0;for(const row of r.rows){try{await sendMessage(page,row.psid,job.message);sent++;}catch(e){failed++;console.error("Broadcast delivery failed:",e.response?.data||e.message);}await new Promise(resolve=>setTimeout(resolve,250));}return{sent,failed,eligible:r.rowCount};}
app.post("/api/broadcasts",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!pageReady(p))return res.status(503).json({error:"Connect a Page first."});const message=String(req.body.message||"").trim();if(!message||message.length>2000)return res.status(400).json({error:"Enter a message up to 2,000 characters."});let at=null;if(req.body.scheduledAt){at=new Date(req.body.scheduledAt);if(Number.isNaN(at.getTime())||at.getTime()<=Date.now())return res.status(400).json({error:"Choose a valid future date and time."});}const status=at?"scheduled":"sending",created=await pool.query(`INSERT INTO broadcasts(page_id,message,scheduled_at,status,locked_at) VALUES($1,$2,$3,$4,CASE WHEN $4='sending' THEN NOW() ELSE NULL END) RETURNING *`,[p.page_id,message,at,status]),job=created.rows[0];if(at)return res.json({success:true,message:"Broadcast scheduled.",broadcast:job});try{const x=await sendBroadcast(job,p);await pool.query(`UPDATE broadcasts SET status='completed',sent_count=$1,failed_count=$2,eligible_count=$3,completed_at=NOW(),locked_at=NULL WHERE id=$4`,[x.sent,x.failed,x.eligible,job.id]);res.json({success:true,message:"Broadcast finished.",...x});}catch(e){await pool.query("UPDATE broadcasts SET status='failed',completed_at=NOW(),locked_at=NULL WHERE id=$1",[job.id]);throw e;}}));
app.get("/api/broadcasts",requireAdmin,asyncRoute(async(req,res)=>{const p=await pageFor(req);if(!p)return res.json([]);const r=await pool.query(`SELECT id,message,scheduled_at,status,sent_count,failed_count,eligible_count,created_at,completed_at FROM broadcasts WHERE page_id=$1 ORDER BY created_at DESC LIMIT 50`,[p.page_id]);res.json(r.rows);}));
let workerRunning=false;
async function processDue(){if(workerRunning)return;workerRunning=true;try{await pool.query(`UPDATE broadcasts SET status='scheduled',locked_at=NULL WHERE status='sending' AND locked_at<NOW()-INTERVAL '30 minutes'`);for(let i=0;i<10;i++){const client=await pool.connect();let job=null;try{await client.query("BEGIN");const r=await client.query(`WITH next_job AS(SELECT id FROM broadcasts WHERE status='scheduled' AND scheduled_at<=NOW() ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE broadcasts b SET status='sending',locked_at=NOW() FROM next_job WHERE b.id=next_job.id RETURNING b.*`);job=r.rows[0]||null;await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}if(!job)break;const p=await getPage(job.page_id);if(!p){await pool.query("UPDATE broadcasts SET status='failed',completed_at=NOW(),locked_at=NULL WHERE id=$1",[job.id]);continue;}try{const x=await sendBroadcast(job,p);await pool.query(`UPDATE broadcasts SET status='completed',sent_count=$1,failed_count=$2,eligible_count=$3,completed_at=NOW(),locked_at=NULL WHERE id=$4`,[x.sent,x.failed,x.eligible,job.id]);}catch(e){console.error("Scheduled broadcast failed:",e.response?.data||e.message);await pool.query("UPDATE broadcasts SET status='failed',completed_at=NOW(),locked_at=NULL WHERE id=$1",[job.id]);}}}catch(e){console.error("Broadcast worker error:",e.message);}finally{workerRunning=false;}}
app.get("/webhook",(req,res)=>{const mode=req.query["hub.mode"],token=req.query["hub.verify_token"],challenge=req.query["hub.challenge"];if(mode==="subscribe"&&VERIFY_TOKEN&&safeEqual(token,VERIFY_TOKEN))return res.status(200).send(challenge);res.sendStatus(403);});
app.post("/webhook",(req,res)=>{
 const sig=req.headers["x-hub-signature-256"];
 console.log("Meta webhook POST received:",{signaturePresent:!!sig,rawBodyPresent:Buffer.isBuffer(req.rawBody),appSecretConfigured:!!APP_SECRET});
 if(!APP_SECRET||!sig||!Buffer.isBuffer(req.rawBody)){console.error("Webhook rejected: missing app secret, signature, or raw request body.");return res.sendStatus(401);}
 const expected="sha256="+crypto.createHmac("sha256",APP_SECRET).update(req.rawBody).digest("hex");
 if(!safeEqual(sig,expected)){console.error("Webhook rejected: Meta signature does not match META_APP_SECRET.");return res.sendStatus(401);}
 let payload;try{payload=JSON.parse(req.rawBody.toString("utf8"));}catch{console.error("Webhook rejected: request body is not valid JSON.");return res.sendStatus(400);}
 const entries=payload.entry||[];
 console.log("Meta webhook signature accepted:",{object:payload.object||null,entries:entries.length,matchingPageEntries:entries.length,messagingEvents:entries.reduce((n,e)=>n+(Array.isArray(e.messaging)?e.messaging.length:0),0),changes:entries.flatMap(e=>(Array.isArray(e.changes)?e.changes:[]).map(c=>({field:c.field||null,item:c.value?.item||null,verb:c.value?.verb||null,hasCommentId:!!(c.value?.comment_id||c.value?.id)}))),webhookEntryCount:entries.length});
 res.sendStatus(200);processPayload(payload).catch(e=>console.error("Webhook handler failed:",e.message));
});
app.get("/health",asyncRoute(async(req,res)=>res.json({status:"ok",app:"IchaBot",adminConfigured:!!ADMIN_PASSWORD,pageConfigured:(await getPages()).length>0,webhookConfigured:!!(APP_SECRET&&VERIFY_TOKEN)})));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((e,req,res,next)=>{console.error("Application error:",e.response?.data||e.stack||e.message);if(res.headersSent)return next(e);res.status(500).json({error:"Something went wrong. Check Render logs."});});
initDatabase().then(()=>app.listen(PORT,()=>{console.log("IchaBot listening at "+APP_BASE_URL);processDue();setInterval(processDue,15000);})).catch(e=>{console.error("IchaBot startup failed:",e);process.exit(1);});
