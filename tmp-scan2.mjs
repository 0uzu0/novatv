const B='http://127.0.0.1:8890';
const live=await (await fetch(B+'/api/live')).json();
const all=[]; for(const g of live.groups||[]) for(const c of g.channels||[]) all.push({g:g.name,...c});
const pick=[]; const seen=new Set();
for(const c of all){ if(seen.has(c.g))continue; seen.add(c.g); pick.push(c); }
for(const c of all) if(pick.length<18 && !pick.includes(c)) pick.push(c);
let ok=0, tested=0;
for(const c of pick){
  const label=`${c.g}/${c.name}`;
  if(!/\.m3u8/i.test(c.url)) continue;
  tested++;
  try{
    const r=await fetch(`${B}/api/proxy?url=${encodeURIComponent(c.url)}`,{signal:AbortSignal.timeout(12000)});
    const t=await r.text();
    if(!t.startsWith('#EXTM3U')){ console.log(`❌ ${label} → HTTP=${r.status} 非m3u8`); continue; }
    const segs=t.split('\n').filter(x=>x.trim()&&!x.startsWith('#'));
    if(!segs.length){ console.log(`⚠️  ${label} → 无分片`); continue; }
    const su=segs[0].startsWith('http')?segs[0]:B+segs[0];
    const r2=await fetch(su,{signal:AbortSignal.timeout(12000)});
    const b=Buffer.from(await r2.arrayBuffer());
    const good=r2.ok&&b.length>1000;
    if(good) ok++;
    console.log(`${good?'✅':'❌'} ${label} → 分片 ${b.length}B ${good?'':'('+(r2.headers.get('content-type')||'').slice(0,18)+')'}`);
  }catch(e){ console.log(`❌ ${label} → ${e.message.slice(0,45)}`); }
}
console.log(`\n可完整播放: ${ok}/${tested}`);
