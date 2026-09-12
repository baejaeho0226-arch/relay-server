"use strict";
const s=require('./store'),segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
function Input(value,previous){
 const text=s.Text(value,80,true);if(text===previous)return text;
 let width=0;
 for(const {segment}of segmenter.segment(text)){
  if(/[\r\n\t]/u.test(segment))s.Fail('POLL_INVALID');
  const cp=segment.codePointAt(0);
  width+=(cp>=0x1100||/\p{Extended_Pictographic}/u.test(segment))?2:1;
 }
 // At most twelve full-width glyphs. APK additionally measures the actual font.
 if(width>24)s.Fail('POLL_TEXT_LONG');return text;
}
module.exports={Input};
