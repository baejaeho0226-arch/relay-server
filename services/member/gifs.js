'use strict';
const pack=require('./gif-pack.json'),s=require('./store');
function Get(id){const row=pack.find(x=>x.id===id);return row?{id:row.id,title:row.title,interval:row.interval,frames:row.frames}:null;}
function Validate(value,previous=''){if(value===undefined)return previous||'';if(value!==''&&!pack.some(x=>x.id===value))s.Fail('GIF_INVALID');return value;}
function List(){return {items:pack.map(x=>Get(x.id))};}
module.exports={Get,Validate,List};
