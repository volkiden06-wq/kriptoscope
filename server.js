import express from "express";
const app=express();
const PORT=process.env.PORT||10000;
app.disable("x-powered-by");
app.use(express.static("public",{etag:true,maxAge:"5m"}));
const HOSTS=["https://data-api.binance.vision","https://api.binance.com","https://api1.binance.com","https://api2.binance.com"];
const STABLE=new Set(["USDC","FDUSD","TUSD","USDP","DAI","USDE","USD1","RLUSD","BUSD","USDT","EUR","AEUR","USDS","PYUSD"]);
async function binance(path){
 let last;
 for(const host of HOSTS){try{const r=await fetch(host+path,{headers:{accept:"application/json"},signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error("Binance HTTP "+r.status);return await r.json()}catch(e){last=e}}
 throw last||new Error("Binance erişilemiyor");
}
app.get("/health",(_req,res)=>res.json({ok:true,service:"KRIPTOSCOPE PRO",time:new Date().toISOString()}));
app.get("/api/market",async(_req,res)=>{res.set("Cache-Control","no-store");try{
 const raw=await binance("/api/v3/ticker/24hr");
 const data=raw.filter(x=>typeof x.symbol==="string"&&x.symbol.endsWith("USDT")&&!STABLE.has(x.symbol.slice(0,-4))&&+x.quoteVolume>100000)
 .map(x=>({symbol:x.symbol,price:+x.lastPrice,change:+x.priceChangePercent,volume:+x.quoteVolume}))
 .filter(x=>Number.isFinite(x.price)&&Number.isFinite(x.change)&&Number.isFinite(x.volume)).sort((a,b)=>b.volume-a.volume);
 res.json({ok:true,count:data.length,updatedAt:Date.now(),data});
 }catch(e){res.status(502).json({ok:false,error:"Binance piyasa verisi alınamadı: "+e.message})}});
const ema=(a,p)=>{let k=2/(p+1),v=a.slice(0,p).reduce((x,y)=>x+y,0)/p;for(let i=p;i<a.length;i++)v=a[i]*k+v*(1-k);return v};
function rsi(a){let g=0,l=0;for(let i=a.length-14;i<a.length;i++){let d=a[i]-a[i-1];if(d>0)g+=d;else l-=d}return 100-100/(1+g/(l||1e-9))}
function macd(a){const z=[];for(let i=25;i<a.length;i++)z.push(ema(a.slice(0,i+1),12)-ema(a.slice(0,i+1),26));const sig=[];for(let i=8;i<z.length;i++)sig.push(ema(z.slice(0,i+1),9));return {hist:z.at(-1)-sig.at(-1),prev:z.at(-2)-sig.at(-2)}}
async function klines(symbol,interval){return binance("/api/v3/klines?symbol="+encodeURIComponent(symbol)+"&interval="+interval+"&limit=100")}
function evaluate(symbol,k1,k4){
 const close=k1.map(x=>+x[4]),vol=k1.map(x=>+x[5]),c4=k4.map(x=>+x[4]);
 const price=close.at(-1),e20=ema(close,20),e50=ema(close,50),e20old=ema(close.slice(0,-5),20),e420=ema(c4,20),e450=ema(c4,50),mom=macd(close),rv=rsi(close);
 const avg=vol.slice(-21,-1).reduce((a,b)=>a+b,0)/20,vr=vol.at(-1)/(avg||1);
 const candleUp=+k1.at(-1)[4]>+k1.at(-1)[1],candleDown=+k1.at(-1)[4]<+k1.at(-1)[1];
 const bull=[price>e20,e20>e50,e20>e20old,e420>e450,mom.hist>0&&mom.hist>mom.prev,rv>=52&&rv<=70,vr>=1.15,candleUp].filter(Boolean).length;
 const bear=[price<e20,e20<e50,e20<e20old,e420<e450,mom.hist<0&&mom.hist<mom.prev,rv>=30&&rv<=48,vr>=1.15,candleDown].filter(Boolean).length;
 const side=bull>=7&&bull>bear?"AL":bear>=7&&bear>bull?"SAT":"BEKLE";
 return {symbol,price,side,score:Math.max(bull,bear),bullScore:bull,bearScore:bear,rsi:+rv.toFixed(1),ema20:e20,ema50:e50,macd:mom.hist,volumeRatio:+vr.toFixed(2),reason:"8 teknik kontrolden "+Math.max(bull,bear)+" onay • 4 saat trend • 1 saat momentum • Hacim "+vr.toFixed(2)+"x",candle:k1.at(-1)[0]};
}
app.get("/api/scan",async(req,res)=>{res.set("Cache-Control","no-store");try{
 if(req.query.symbol){const sym=String(req.query.symbol).toUpperCase();if(!/^[A-Z0-9]{2,20}USDT$/.test(sym))return res.status(400).json({error:"Geçersiz USDT paritesi"});const [a,b]=await Promise.all([klines(sym,"1h"),klines(sym,"4h")]);const analysis=evaluate(sym,a,b);const points=a.slice(-60).map(x=>({time:+x[0],price:+x[4]}));return res.json({ok:true,analysis,closes:a.map(x=>+x[4]),points})}
 const tick=await binance("/api/v3/ticker/24hr");const list=tick.filter(x=>typeof x.symbol==="string"&&x.symbol.endsWith("USDT")&&!STABLE.has(x.symbol.slice(0,-4))&&+x.quoteVolume>5000000).sort((a,b)=>+b.quoteVolume-+a.quoteVolume).slice(0,30);
 const results=await Promise.all(list.map(async t=>{try{const [a,b]=await Promise.all([klines(t.symbol,"1h"),klines(t.symbol,"4h")]);const v=evaluate(t.symbol,a,b);return {...v,change:+t.priceChangePercent}}catch{return null}}));
 const signals=results.filter(x=>x&&(x.side==="AL"&&x.change>0||x.side==="SAT"&&x.change<0)).sort((a,b)=>b.score-a.score);
 res.json({ok:true,scanned:list.length,signals,updatedAt:Date.now()});
 }catch(e){res.status(502).json({ok:false,error:"Tarama başarısız: "+e.message})}});
app.get("*",(_req,res)=>res.sendFile(process.cwd()+"/public/index.html"));
app.listen(PORT,"0.0.0.0",()=>console.log("KRIPTOSCOPE PRO listening on "+PORT));
