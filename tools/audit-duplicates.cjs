const fs=require('fs');
const src=fs.readFileSync('UK (9).html','utf8').split('\n');
const out=[];
src.forEach((l,i)=>{
  const m=/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^\s*(?:window\.)?([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?function|^\s*const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/.exec(l);
  if(m) out.push({line:i+1,name:m[1]||m[2]||m[3]});
});
const seen={};
out.forEach(o=>{(seen[o.name]=seen[o.name]||[]).push(o.line)});
const dups=Object.entries(seen).filter(([k,v])=>v.length>1);
fs.writeFileSync('extract/functions.txt',out.map(o=>o.line+'\t'+o.name).join('\n'));
console.log('total defs:',out.length,' unique:',Object.keys(seen).length);
console.log('\n=== DUPLICATE DEFINITIONS ('+dups.length+') ===');
dups.forEach(([k,v])=>console.log(' ',k,'->',v.join(', ')));
