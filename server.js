require("dotenv").config();
const express=require("express"),axios=require("axios"),path=require("path"),crypto=require("crypto"),session=require("express-session"),PgSession=require("connect-pg-simple")(session),helmet=require("helmet"),{Pool}=require("pg");
const app=express(),PORT=process.env.PORT||3000;
const GRAPH_VERSION=(process.env.META_GRAPH_VERSION||"v25.0").replace(/^\/?/,"v").replace(/^vv/,"v"),GRAPH_BASE="https://graph.facebook.com/"+GRAPH_VERSION;
const PAGE_ID=String(process.env.PAGE_ID||"").trim(),PAGE_ACCESS_TOKEN=String(process.env.PAGE_ACCESS_TOKEN||"").trim(),PAGE_NAME=String(process.env.PAGE_NAME||"Connected Facebook Page").trim();
const APP_SECRET=process.env.META_APP_SECRET||"",VERIFY_TOKEN=process.env.META_WEBHOOK_VERIFY_TOKEN||"",ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"",SESSION_SECRET=process.env.SESSION_SECRET||"",META_APP_ID=String(process.env.META_APP_ID||"").trim(),FACEBOOK_ADMIN_ID=String(process.env.FACEBOOK_ADMIN_ID||"").trim();
const APP_BASE_URL=(process.env.APP_BASE_URL||process.env.RENDER_EXTERNAL_URL||"https://ichabotnd.onrender.com").replace(/\/+$/,"");
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is missing.");
if(SESSION_SECRET.length<32)throw new Error("SESSION_SECRET must be at least 32 characters.");
if(!APP_SECRET)console.warn("META_APP_SECRET is not configured.");
if(!VERIFY_TOKEN)console.warn("META_WEBHOOK_VERIFY_TOKEN is not configured.");
if(!ADMIN_PASSWORD)console.warn("ADMIN_PASSWORD is not configured; dashboard login will remain locked.");
if(!PAGE_ID||!PAGE_ACCESS_TOKEN)console.warn("PAGE_ID and PAGE_ACCESS_TOKEN are required to connect the Page.");
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="true"?{rejectUnauthorized:false}:undefined});
pool.on("error",e=>console.error("Database error:",e.message));
const safeEqual=(a,b)=>{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
app.set("trust proxy",1);app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"1mb",verify:(req,res,b)=>{if(req.path==="/webhook")req.rawBody=Buffer.from(b);}}));
app.use(express.urlencoded({extended:true}));
app.use(session({store:new PgSession({pool,tableName:"user_sessions",createTableIfMissing:true}),secret:SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}}));
app.use(express.static(path.join(__dirname,"public")));
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const requireAdmin=(req,res,next)=>req.session.adminAuthenticated?next():res.status(401).json({error:"Please sign in to the IchaBot dashboard."});
const pageReady=()=>Boolean(PAGE_ID&&PAGE_ACCESS_TOKEN),facebookLoginReady=()=>Boolean(META_APP_ID&&APP_SECRET&&FACEBOOK_ADMIN_ID);
async function graphPost(endpoint,data){const r=await axios.post(GRAPH_BASE+"/"+endpoint,data,{params:{access_token:PAGE_ACCESS_TOKEN},timeout:20000});return r.data;}
async function initDatabase(){
 await pool.query(`CREATE TABLE IF NOT EXISTS settings(page_id TEXT PRIMARY KEY,welcome_enabled BOOLEAN NOT NULL DEFAULT TRUE,welcome_message TEXT NOT NULL DEFAULT 'Hello! Thanks for messaging us. How can we help you today?',default_enabled BOOLEAN NOT NULL DEFAULT TRUE,default_reply TEXT NOT NULL DEFAULT 'Thanks for your message. We will get back to you shortly.',comment_enabled BOOLEAN NOT NULL DEFAULT TRUE,comment_reply TEXT NOT NULL DEFAULT 'Thanks for your comment! We have sent you a private message.',updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await pool.query(`CREATE TABLE IF NOT EXISTS saved_messages(id BIGSERIAL PRIMARY KEY,page_id TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS saved_messages_page_idx ON saved_messages(page_id,updated_at DESC)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS contacts(page_id TEXT NOT NULL,psid TEXT NOT NULL,last_interaction TIMESTAMPTZ DEFAULT NOW(),first_message BOOLEAN NOT NULL DEFAULT TRUE,welcome_claimed_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(page_id,psid))`);
 await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_message BOOLEAN NOT NULL DEFAULT TRUE`);
 await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS welcome_claimed_at TIMESTAMPTZ`);
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
 if(PAGE_ID)await pool.query(`INSERT INTO settings(page_id) VALUES($1) ON CONFLICT(page_id) DO NOTHING`,[PAGE_ID]);
 console.log("IchaBot database is ready.");
}
async function getSettings(){if(!PAGE_ID)return null;await pool.query(`INSERT INTO settings(page_id) VALUES($1) ON CONFLICT(page_id) DO NOTHING`,[PAGE_ID]);return (await pool.query(`SELECT * FROM settings WHERE page_id=$1`,[PAGE_ID])).rows[0];}
async function sendMessage(psid,message){if(!pageReady())throw new Error("Facebook Page connection is not configured.");return graphPost(PAGE_ID+"/messages",{recipient:{id:psid},messaging_type:"RESPONSE",message:{text:message}});}
async function claimEvent(id){const r=await pool.query(`INSERT INTO processed_events(event_id,status,updated_at) VALUES($1,'processing',NOW()) ON CONFLICT(event_id) DO UPDATE SET status='processing',updated_at=NOW() WHERE processed_events.status='failed' OR (processed_events.status='processing' AND processed_events.updated_at<NOW()-INTERVAL '5 minutes') RETURNING event_id`,[id]);return r.rowCount>0;}
async function finishEvent(id,ok){await pool.query(`UPDATE processed_events SET status=$2,updated_at=NOW() WHERE event_id=$1`,[id,ok?"processed":"failed"]);}
async function processMessage(event){
 if(!event.sender?.id||event.message?.is_echo||!pageReady())return;
 const psid=String(event.sender.id),mid=event.message?.mid,eventId=mid?"message:"+PAGE_ID+":"+mid:null;
 if(eventId&&!(await claimEvent(eventId)))return;
 try{
  const s=await getSettings();
  await pool.query(`INSERT INTO contacts(page_id,psid,last_interaction,first_message) VALUES($1,$2,NOW(),TRUE) ON CONFLICT(page_id,psid) DO UPDATE SET last_interaction=NOW()`,[PAGE_ID,psid]);
  const c=await pool.query(`UPDATE contacts SET welcome_claimed_at=NOW() WHERE page_id=$1 AND psid=$2 AND first_message=TRUE AND (welcome_claimed_at IS NULL OR welcome_claimed_at<NOW()-INTERVAL '5 minutes') RETURNING psid`,[PAGE_ID,psid]);
  const first=c.rowCount>0,reply=first&&s.welcome_enabled?s.welcome_message:(s.default_enabled?s.default_reply:"");
  if(reply){try{await sendMessage(psid,reply);if(first)await pool.query(`UPDATE contacts SET first_message=FALSE,welcome_claimed_at=NULL WHERE page_id=$1 AND psid=$2`,[PAGE_ID,psid]);}catch(e){if(first)await pool.query(`UPDATE contacts SET welcome_claimed_at=NULL WHERE page_id=$1 AND psid=$2`,[PAGE_ID,psid]);throw e;}}
  else if(first)await pool.query(`UPDATE contacts SET first_message=FALSE,welcome_claimed_at=NULL WHERE page_id=$1 AND psid=$2`,[PAGE_ID,psid]);
  if(eventId)await finishEvent(eventId,true);
 }catch(e){if(eventId)await finishEvent(eventId,false);throw e;}
}
async function processComment(v){
 if(!pageReady()||!v){console.warn("Comment event skipped: Page connection or event value missing.");return;}
 if(v.item!=="comment"||v.verb!=="add"){console.log("Feed event is not a new comment:",{item:v.item||null,verb:v.verb||null});return;}
 const id=String(v.comment_id||v.id||"");
 if(!id){console.warn("New comment event has no comment_id.");return;}
 if(v.from&&String(v.from.id)===PAGE_ID){console.log("Ignoring comment authored by the connected Page.");return;}
 const eventId="comment:"+PAGE_ID+":"+id;
 if(!(await claimEvent(eventId))){console.log("Comment event already processed or currently claimed.");return;}
 try{
  const s=await getSettings();
  if(!s||!s.comment_enabled){console.log("Comment automation is disabled in saved settings.");await finishEvent(eventId,true);return;}
  let likeOk=false,replyOk=!s.comment_reply;
  try{await graphPost(id+"/likes",{});likeOk=true;console.log("Comment like succeeded.");}
  catch(e){console.error("Comment like failed:",e.response?.data||e.message);}
  if(s.comment_reply){
   try{await graphPost(id+"/private_replies",{message:s.comment_reply});replyOk=true;console.log("Private comment reply succeeded.");}
   catch(e){console.error("Private comment reply failed:",e.response?.data||e.message);}
  }
  await finishEvent(eventId,replyOk);
  if(!replyOk)console.error("Comment event marked failed so it can be retried; like succeeded:",likeOk);
 }catch(e){await finishEvent(eventId,false);throw e;}
}
async function processPayload(payload){
 const entries=Array.isArray(payload?.entry)?payload.entry:[];
 for(const entry of entries){
  const matches=!PAGE_ID||String(entry.id)===PAGE_ID;
  const changes=Array.isArray(entry.changes)?entry.changes:[];
  console.log("Meta webhook entry:",{pageIdMatches:matches,messagingEvents:Array.isArray(entry.messaging)?entry.messaging.length:0,changes:changes.map(c=>({field:c.field||null,item:c.value?.item||null,verb:c.value?.verb||null,hasCommentId:!!(c.value?.comment_id||c.value?.id),hasPostId:!!c.value?.post_id}))});
  if(!matches){console.warn("Webhook entry ignored because its Page ID does not match PAGE_ID.");continue;}
  for(const e of entry.messaging||[]){try{await processMessage(e);}catch(err){console.error("Messenger event failed:",err.response?.data||err.message);}}
  for(const change of changes){if(change.field==="feed")try{await processComment(change.value);}catch(err){console.error("Comment event failed:",err.response?.data||err.message);}}
 }
}
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
app.get("/api/me",(req,res)=>res.json({authenticated:!!req.session.adminAuthenticated,pageConnected:pageReady(),pageName:pageReady()?PAGE_NAME:null,pageId:pageReady()?PAGE_ID:null,facebookLoginEnabled:facebookLoginReady(),needsSetup:!ADMIN_PASSWORD||!PAGE_ID||!PAGE_ACCESS_TOKEN||!APP_SECRET||!VERIFY_TOKEN}));
app.get("/api/audience",requireAdmin,asyncRoute(async(req,res)=>{
 if(!PAGE_ID)return res.status(503).json({error:"PAGE_ID is missing in Render."});
 const r=await pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE last_interaction>NOW()-INTERVAL '24 hours')::int AS eligible FROM contacts WHERE page_id=$1`,[PAGE_ID]);
 res.json({total:Number(r.rows[0].total||0),eligible:Number(r.rows[0].eligible||0),windowHours:24});
}));
app.get("/api/saved-messages",requireAdmin,asyncRoute(async(req,res)=>{
 if(!PAGE_ID)return res.status(503).json({error:"PAGE_ID is missing in Render."});
 const r=await pool.query(`SELECT id,title,message,created_at,updated_at FROM saved_messages WHERE page_id=$1 ORDER BY updated_at DESC,id DESC`,[PAGE_ID]);res.json(r.rows);
}));
app.post("/api/saved-messages",requireAdmin,asyncRoute(async(req,res)=>{
 if(!PAGE_ID)return res.status(503).json({error:"PAGE_ID is missing in Render."});
 const title=String(req.body.title||"").trim(),message=String(req.body.message||"").trim(),id=Number(req.body.id||0);
 if(!title)return res.status(400).json({error:"Enter a name for this saved message."});
 if(title.length>80)return res.status(400).json({error:"Message name must be 80 characters or less."});
 if(!message)return res.status(400).json({error:"Write a message before saving."});
 if(message.length>2000)return res.status(400).json({error:"Message must be 2,000 characters or less."});
 if(id>0){const r=await pool.query(`UPDATE saved_messages SET title=$1,message=$2,updated_at=NOW() WHERE id=$3 AND page_id=$4 RETURNING id,title,message,created_at,updated_at`,[title,message,id,PAGE_ID]);if(!r.rowCount)return res.status(404).json({error:"Saved message was not found."});return res.json({success:true,message:"Saved message updated.",savedMessage:r.rows[0]});}
 const r=await pool.query(`INSERT INTO saved_messages(page_id,title,message) VALUES($1,$2,$3) RETURNING id,title,message,created_at,updated_at`,[PAGE_ID,title,message]);res.status(201).json({success:true,message:"Saved message created.",savedMessage:r.rows[0]});
}));
app.delete("/api/saved-messages/:id",requireAdmin,asyncRoute(async(req,res)=>{
 if(!PAGE_ID)return res.status(503).json({error:"PAGE_ID is missing in Render."});
 const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:"Invalid saved message ID."});
 const r=await pool.query(`DELETE FROM saved_messages WHERE id=$1 AND page_id=$2 RETURNING id`,[id,PAGE_ID]);if(!r.rowCount)return res.status(404).json({error:"Saved message was not found."});res.json({success:true});
}));
app.get("/api/settings",requireAdmin,asyncRoute(async(req,res)=>{if(!PAGE_ID)return res.status(503).json({error:"PAGE_ID is missing in Render."});res.json(await getSettings());}));
app.post("/api/settings",requireAdmin,asyncRoute(async(req,res)=>{
 if(!PAGE_ID)return res.status(503).json({error:"PAGE_ID is missing in Render."});
 const w=String(req.body.welcome_message||"").trim(),d=String(req.body.default_reply||"").trim(),c=String(req.body.comment_reply||"").trim();
 if([w,d,c].some(x=>x.length>2000))return res.status(400).json({error:"Each reply must be 2,000 characters or less."});
 await pool.query(`INSERT INTO settings(page_id,welcome_enabled,welcome_message,default_enabled,default_reply,comment_enabled,comment_reply,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(page_id) DO UPDATE SET welcome_enabled=EXCLUDED.welcome_enabled,welcome_message=EXCLUDED.welcome_message,default_enabled=EXCLUDED.default_enabled,default_reply=EXCLUDED.default_reply,comment_enabled=EXCLUDED.comment_enabled,comment_reply=EXCLUDED.comment_reply,updated_at=NOW()`,[PAGE_ID,req.body.welcome_enabled===true,w,req.body.default_enabled===true,d,req.body.comment_enabled===true,c]);
 res.json({success:true,message:"Automation settings saved."});
}));
async function sendBroadcast(job){
 const contacts=await pool.query(`SELECT psid FROM contacts WHERE page_id=$1 AND last_interaction>NOW()-INTERVAL '24 hours' ORDER BY last_interaction DESC LIMIT 5000`,[PAGE_ID]);
 let sent=0,failed=0;
 for(const row of contacts.rows){try{await sendMessage(row.psid,job.message);sent++;}catch(e){failed++;console.error("Broadcast delivery failed:",e.response?.data||e.message);}await new Promise(r=>setTimeout(r,250));}
 return{sent,failed,eligible:contacts.rowCount};
}
app.post("/api/broadcasts",requireAdmin,asyncRoute(async(req,res)=>{
 if(!pageReady())return res.status(503).json({error:"Facebook Page connection is not configured in Render."});
 const message=String(req.body.message||"").trim();if(!message)return res.status(400).json({error:"Enter a message."});if(message.length>2000)return res.status(400).json({error:"Message must be 2,000 characters or less."});
 let at=null;if(req.body.scheduledAt){at=new Date(req.body.scheduledAt);if(Number.isNaN(at.getTime())||at.getTime()<=Date.now())return res.status(400).json({error:"Choose a valid future date and time."});}
 const status=at?"scheduled":"sending",created=await pool.query(`INSERT INTO broadcasts(page_id,message,scheduled_at,status,locked_at) VALUES($1,$2,$3,$4,CASE WHEN $4='sending' THEN NOW() ELSE NULL END) RETURNING *`,[PAGE_ID,message,at,status]),job=created.rows[0];
 if(at)return res.json({success:true,message:"Broadcast scheduled.",broadcast:job});
 try{const r=await sendBroadcast(job);await pool.query(`UPDATE broadcasts SET status='completed',sent_count=$1,failed_count=$2,eligible_count=$3,completed_at=NOW(),locked_at=NULL WHERE id=$4`,[r.sent,r.failed,r.eligible,job.id]);res.json({success:true,message:"Broadcast finished.",...r});}
 catch(e){await pool.query(`UPDATE broadcasts SET status='failed',completed_at=NOW(),locked_at=NULL WHERE id=$1`,[job.id]);throw e;}
}));
app.get("/api/broadcasts",requireAdmin,asyncRoute(async(req,res)=>{const r=await pool.query(`SELECT id,message,scheduled_at,status,sent_count,failed_count,eligible_count,created_at,completed_at FROM broadcasts WHERE page_id=$1 ORDER BY created_at DESC LIMIT 50`,[PAGE_ID||""]);res.json(r.rows);}));
let workerRunning=false;
async function processDue(){
 if(workerRunning||!pageReady())return;workerRunning=true;
 try{
  await pool.query(`UPDATE broadcasts SET status='scheduled',locked_at=NULL WHERE status='sending' AND locked_at<NOW()-INTERVAL '30 minutes'`);
  for(let i=0;i<3;i++){
   const client=await pool.connect();let job=null;
   try{await client.query("BEGIN");const r=await client.query(`WITH next_job AS(SELECT id FROM broadcasts WHERE page_id=$1 AND status='scheduled' AND scheduled_at<=NOW() ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE broadcasts b SET status='sending',locked_at=NOW() FROM next_job WHERE b.id=next_job.id RETURNING b.*`,[PAGE_ID]);job=r.rows[0]||null;await client.query("COMMIT");}
   catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
   if(!job)break;
   try{const r=await sendBroadcast(job);await pool.query(`UPDATE broadcasts SET status='completed',sent_count=$1,failed_count=$2,eligible_count=$3,completed_at=NOW(),locked_at=NULL WHERE id=$4`,[r.sent,r.failed,r.eligible,job.id]);}
   catch(e){console.error("Scheduled broadcast failed:",e.response?.data||e.message);await pool.query(`UPDATE broadcasts SET status='failed',completed_at=NOW(),locked_at=NULL WHERE id=$1`,[job.id]);}
  }
 }catch(e){console.error("Broadcast worker error:",e.message);}finally{workerRunning=false;}
}
app.get("/webhook",(req,res)=>{const mode=req.query["hub.mode"],token=req.query["hub.verify_token"],challenge=req.query["hub.challenge"];if(mode==="subscribe"&&VERIFY_TOKEN&&safeEqual(token,VERIFY_TOKEN))return res.status(200).send(challenge);res.sendStatus(403);});
app.post("/webhook",(req,res)=>{
 const sig=req.headers["x-hub-signature-256"];
 console.log("Meta webhook POST received:",{signaturePresent:!!sig,rawBodyPresent:Buffer.isBuffer(req.rawBody),appSecretConfigured:!!APP_SECRET});
 if(!APP_SECRET||!sig||!Buffer.isBuffer(req.rawBody)){console.error("Webhook rejected: missing app secret, signature, or raw request body.");return res.sendStatus(401);}
 const expected="sha256="+crypto.createHmac("sha256",APP_SECRET).update(req.rawBody).digest("hex");
 if(!safeEqual(sig,expected)){console.error("Webhook rejected: Meta signature does not match META_APP_SECRET.");return res.sendStatus(401);}
 let payload;try{payload=JSON.parse(req.rawBody.toString("utf8"));}catch{console.error("Webhook rejected: request body is not valid JSON.");return res.sendStatus(400);}
 const entries=payload.entry||[];
 console.log("Meta webhook signature accepted:",{object:payload.object||null,entries:entries.length,matchingPageEntries:entries.filter(e=>!PAGE_ID||String(e.id)===PAGE_ID).length,messagingEvents:entries.reduce((n,e)=>n+(Array.isArray(e.messaging)?e.messaging.length:0),0),changes:entries.flatMap(e=>(Array.isArray(e.changes)?e.changes:[]).map(c=>({field:c.field||null,item:c.value?.item||null,verb:c.value?.verb||null,hasCommentId:!!(c.value?.comment_id||c.value?.id)}))),pageIdConfigured:!!PAGE_ID});
 res.sendStatus(200);processPayload(payload).catch(e=>console.error("Webhook handler failed:",e.message));
});
app.get("/health",(req,res)=>res.json({status:"ok",app:"IchaBot",adminConfigured:!!ADMIN_PASSWORD,pageConfigured:pageReady(),webhookConfigured:!!(APP_SECRET&&VERIFY_TOKEN)}));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((e,req,res,next)=>{console.error("Application error:",e.response?.data||e.stack||e.message);if(res.headersSent)return next(e);res.status(500).json({error:"Something went wrong. Check Render logs."});});
initDatabase().then(()=>app.listen(PORT,()=>{console.log("IchaBot listening at "+APP_BASE_URL);processDue();setInterval(processDue,15000);})).catch(e=>{console.error("IchaBot startup failed:",e);process.exit(1);});
