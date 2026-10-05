const http=require('http'),fs=require('fs'),path=require('path'),{WebSocketServer}=require('ws');
const root=path.join(__dirname,'public');
const rooms=new Map();
function code(){let s='';const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';do{s='';for(let i=0;i<6;i++)s+=a[Math.floor(Math.random()*a.length)]}while(rooms.has(s));return s}
const server=http.createServer((req,res)=>{let u=decodeURIComponent(req.url.split('?')[0]);if(u==='/')u='/index.html';let f=path.join(root,u);if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('Not found')}let ext=path.extname(f),types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});fs.createReadStream(f).pipe(res)});
const wss=new WebSocketServer({server});
wss.on('connection',ws=>{ws.room=null;ws.role=null;ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}
 if(m.type==='create'){let r=code();rooms.set(r,{host:ws,client:null});ws.room=r;ws.role='host';ws.send(JSON.stringify({type:'room',room:r}));return}
 if(m.type==='join'){let r=String(m.room||'').toUpperCase(),room=rooms.get(r);if(!room||room.client){ws.send(JSON.stringify({type:'error',message:'Room unavailable'}));return}room.client=ws;ws.room=r;ws.role='client';room.host.send(JSON.stringify({type:'join'}));ws.send(JSON.stringify({type:'joined',room:r}));return}
 if(!ws.room)return;let room=rooms.get(ws.room);if(!room)return;
 if(m.type==='input'&&ws.role==='client')room.host.send(JSON.stringify(m));
 if(m.type==='state'&&ws.role==='host')room.client?.send(JSON.stringify(m));
 });ws.on('close',()=>{if(ws.room&&rooms.has(ws.room)){let r=rooms.get(ws.room);let other=ws.role==='host'?r.client:r.host;if(other?.readyState===1)other.send(JSON.stringify({type:'left'}));if(ws.role==='host'||!r.host)rooms.delete(ws.room)}})});
const port=process.env.PORT||8080;server.listen(port,()=>console.log(`Stickman Clash web server listening on http://localhost:${port}`));
