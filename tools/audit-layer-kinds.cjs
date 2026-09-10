const fs=require('fs');
const names=['radarOptions','satelliteOptions','lightningOptions','tropicalStormsOptions','rotationOptions','surfaceFrontOptions','observationOptions','nowcastOptions','warningOptions','isobarOptions'];
const types={},props=new Set();let total=0;
for(const n of names){
  const body=fs.readFileSync('extract/'+n+'.txt','utf8');
  let obj;
  try{ obj=eval('('+body+')'); }catch(e){ console.log('PARSE FAIL',n,e.message); continue; }
  for(const [k,v] of Object.entries(obj)){
    total++;
    const t=(v&&v.type)||'(none)';
    (types[t]=types[t]||[]).push(n.replace('Options','')+':'+k);
    if(v&&typeof v==='object') Object.keys(v).forEach(p=>props.add(p));
  }
}
console.log('TOTAL LAYER DEFS:',total);
console.log('\n=== RENDERER TYPES ===');
for(const [t,l] of Object.entries(types).sort((a,b)=>b[1].length-a[1].length)) console.log(String(l.length).padStart(4),t);
console.log('\n=== ALL CONFIG PROPS ===');
console.log([...props].sort().join(', '));
