require("dotenv").config();
const express=require("express"),axios=require("axios"),path=require("path"),crypto=require("crypto"),session=require("express-session"),PgSession=require("connect-pg-simple")(session),helmet=require("helmet"),{Pool}=require("pg");
const app=express(),PORT=process.env.PORT||3000;
const GRAPH_VERSION=(process.env.META_GRAPH_VERSION||"v25.0").replace(/^\/?/,"v").replace(/^vv/,"v"),GRAPH_BASE="https://graph.facebook.com/"+GRAPH_VERSION;
const PAGE_ID=String(process.env.PAGE_ID||"").trim(),PAGE_ACCESS_TOKEN=String(process.env.PAGE_ACCESS_TOKEN||"").trim(),PAGE_NAME=String(process.env.PAGE_NAME||"Connected Facebook Page").trim();
const APP_SECRET=process.env.META_APP_SECRET||"",VERIFY_TOKEN=process.env.META_WEBHOOK_VERIFY_TOKEN||"",ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"",SESSION_SECRET=process.env.SESSION_SECRET||"";
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
const pageReady=()=>Boolean(PAGE_ID&&PAGE_ACCESS_TOKEN);
async function graphPost(endpoint,data){const r=await axios.post(GRAPH_BASE+"/"+endpoint,data,{params:{access_token:PAGE_ACCESS_TOKEN},timeout:20000});return r.data;}
async function initDatabase(){
 await pool.query(`CREATE TABLE IF NOT EXISTS settings(page_id TEXT PRIMARY KEY,welcome_enabled BOOLEAN NOT NULL DEFAULT TRUE,welcome_message TEXT NOT NULL DEFAULT 'Hello! Thanks for messaging us. How can we help you today?',default_enabled BOOLEAN NOT NULL DEFAULT TRUE,default_reply TEXT NOT NULL DEFAULT 'Thanks for your message. We will get back to you shortly.',comment_enabled BOOLEAN NOT NULL DEFAULT TRUE,comment_reply TEXT NOT NULL DEFAULT 'Thanks for your comment! We have sent you a private message.',updated_at TIMESTAMPTZ DEFAULT NOW())`);
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
 if(!pageReady()||!v||v.item!=="comment"||v.verb!=="add")return;
 const id=v.comment_id||v.id;if(!id||(v.from&&String(v.from.id)===PAGE_ID))return;
 const eventId="comment:"+PAGE_ID+":"+id;if(!(await claimEvent(eventId)))return;
 try{const s=await getSettings();if(s.comment_enabled&&s.comment_reply)await graphPost(id+"/private_replies",{message:s.comment_reply});await finishEvent(eventId,true);}
 catch(e){await finishEvent(eventId,false);throw e;}
}
async function processPayload(payload){for(const entry of payload.entry||[]){if(PAGE_ID&&String(entry.id)!==PAGE_ID)continue;for(const e of entry.messaging||[]){try{await processMessage(e);}catch(err){console.error("Messenger event failed:",err.response?.data||err.message);}}for(const c of entry.changes||[]){if(c.field==="feed")try{await processComment(c.value);}catch(err){console.error("Comment event failed:",err.response?.data||err.message);}}}}
app.post("/api/login",(req,res)=>{
 if(!ADMIN_PASSWORD)return res.status(503).json({error:"ADMIN_PASSWORD must be added to Render Environment before sign-in."});
 if(!safeEqual(req.body.password,ADMIN_PASSWORD))return res.status(401).json({error:"Incorrect dashboard password."});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:"Could not start secure session."});req.session.adminAuthenticated=true;req.session.save(e=>e?res.status(500).json({error:"Could not save session."}):res.json({success:true}));});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.get("/api/me",(req,res)=>res.json({authenticated:!!req.session.adminAuthenticated,pageConnected:pageReady(),pageName:pageReady()?PAGE_NAME:null,pageId:pageReady()?PAGE_ID:null,needsSetup:!ADMIN_PASSWORD||!PAGE_ID||!PAGE_ACCESS_TOKEN||!APP_SECRET||!VERIFY_TOKEN}));
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
 const sig=req.headers["x-hub-signature-256"];if(!APP_SECRET||!sig||!Buffer.isBuffer(req.rawBody))return res.sendStatus(401);
 const expected="sha256="+crypto.createHmac("sha256",APP_SECRET).update(req.rawBody).digest("hex");if(!safeEqual(sig,expected))return res.sendStatus(401);
 let payload;try{payload=JSON.parse(req.rawBody.toString("utf8"));}catch{return res.sendStatus(400);}
 res.sendStatus(200);processPayload(payload).catch(e=>console.error("Webhook handler failed:",e.message));
});
app.get("/health",(req,res)=>res.json({status:"ok",app:"IchaBot",adminConfigured:!!ADMIN_PASSWORD,pageConfigured:pageReady(),webhookConfigured:!!(APP_SECRET&&VERIFY_TOKEN)}));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((e,req,res,next)=>{console.error("Application error:",e.response?.data||e.stack||e.message);if(res.headersSent)return next(e);res.status(500).json({error:"Something went wrong. Check Render logs."});});
initDatabase().then(()=>app.listen(PORT,()=>{console.log("IchaBot listening at "+APP_BASE_URL);processDue();setInterval(processDue,15000);})).catch(e=>{console.error("IchaBot startup failed:",e);process.exit(1);});
