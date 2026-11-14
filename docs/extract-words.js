const fs=require('fs');const src=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
const js=src.slice(src.indexOf('<script>')+8, src.lastIndexOf('</script>'));
function grab(name){const i=js.indexOf(name);let j=js.indexOf('=',i)+1;while(js[j]==' ')j++;let d=0,k=j;for(;k<js.length;k++){const c=js[k];if(c=='['||c=='{')d++;else if(c==']'||c=='}'){d--;if(d==0){k++;break;}}}return eval('('+js.slice(j,k)+')');}
const out={PACKS:grab('const PACKS'),TABOO:grab('const TABOO'),IMP:grab('const IMP_WORDS'),TELE:grab('const TELE_WORDS'),WAVE:grab('const WAVE'),SPY_L3:grab('const SPY_L3')};
const single=s=>!/\s/.test(s);
const pool=src=>[...new Set(src.filter(single).map(w=>w.toLowerCase()))];
out.SPY1=pool([...out.TABOO[1].map(c=>c[0]),...out.TELE[1],...out.IMP["Animals"],...out.IMP["Food"],...out.IMP["Things at home"]]);
out.SPY2=pool([...out.TABOO[2].map(c=>c[0]),...out.TELE[2],...out.IMP["Places"],...out.IMP["Jobs"],...out.IMP["Sports & games"]]);
out.SPY3=pool(out.SPY_L3);
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,1));
console.log(Object.keys(out.IMP).map(k=>k+':'+out.IMP[k].length).join(' | '));
console.log(Object.keys(out.WAVE).map(k=>k+':'+out.WAVE[k].length).join(' | '), 'spy', out.SPY1.length,out.SPY2.length,out.SPY3.length);
