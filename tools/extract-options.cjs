const fs=require('fs');
const BS=String.fromCharCode(92);
const src=fs.readFileSync('UK (9).html','utf8');
const names=['radarOptions','satelliteOptions','lightningOptions','tropicalStormsOptions','rotationOptions','surfaceFrontOptions','observationOptions','nowcastOptions','warningOptions','isobarOptions','windOptions'];
fs.mkdirSync('extract',{recursive:true});
function scan(start){
  let i=start,depth=0,inS=null,esc=false;
  for(;i<src.length;i++){
    const c=src[i],n=src[i+1];
    if(esc){esc=false;continue;}
    if(inS){ if(c===BS){esc=true;continue;} if(c===inS) inS=null; continue; }
    if(c==='/'&&n==='/'){ while(i<src.length&&src[i]!=='\n')i++; continue; }
    if(c==='/'&&n==='*'){ i+=2; while(i<src.length&&!(src[i]==='*'&&src[i+1]==='/'))i++; i++; continue; }
    if(c==='"'||c==="'"||c==='`'){inS=c;continue;}
    if(c==='{')depth++;
    else if(c==='}'){depth--; if(depth===0) return i+1;}
  }
  return -1;
}
for(const n of names){
  const re=new RegExp('const'+BS+'s+'+n+BS+'s*='+BS+'s*'+BS+'{');
  const m=re.exec(src);
  if(!m){console.log('MISS',n);continue;}
  const s=m.index+m[0].length-1;
  const e=scan(s);
  const body=src.slice(s,e);
  fs.writeFileSync('extract/'+n+'.txt',body);
  const keys=(body.match(/^\s+'[^']+'\s*:\s*\{/gm)||[]).length;
  console.log(n.padEnd(26), String(body.length).padStart(7), 'chars', String(keys).padStart(4),'entries');
}
