/** Bounded simple polygon validation shared by hosts and structured resources. */
export function validateSimplePolygon(points:readonly {x:number;y:number}[],allowEmpty=true):void{
 if(allowEmpty&&points.length===0)return;
 const fail=()=>{throw Error('E_PROPERTY_VALUE: polygon must be a simple nondegenerate polygon with 3..256 vertices');};
 if(points.length<3||points.length>256||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))fail();
 const cross=(a:typeof points[number],b:typeof a,c:typeof a)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
 let area=0;for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!;if(a.x===b.x&&a.y===b.y)fail();area+=a.x*b.y-b.x*a.y;}
 if(Math.abs(area)<1e-9)fail();
 const on=(a:typeof points[number],b:typeof a,p:typeof a)=>Math.abs(cross(a,b,p))<1e-9&&p.x>=Math.min(a.x,b.x)-1e-9&&p.x<=Math.max(a.x,b.x)+1e-9&&p.y>=Math.min(a.y,b.y)-1e-9&&p.y<=Math.max(a.y,b.y)+1e-9;
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){if(j===i+1||i===0&&j===points.length-1)continue;const a=points[i]!,b=points[(i+1)%points.length]!,c=points[j]!,d=points[(j+1)%points.length]!;if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))fail();}
}
