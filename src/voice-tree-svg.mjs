const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function voiceTreeSvg(state){
  const height=state.steps.length*190+230,shapes=[],cards=[];
  const card=(x,y,w,text,color,label)=>{
    const width=Math.floor((w-24)/14);
    cards.push(`<rect x="${x}" y="${y}" width="${w}" height="110" rx="10" fill="${color}" stroke="#cbd5e1"/><text class="label" x="${x+12}" y="${y+20}">${escape(label)}</text>`);
    for(let i=0;i<Math.min(text.length,width*4);i+=width)cards.push(`<text x="${x+12}" y="${y+44+Math.floor(i/width)*20}">${escape(text.slice(i,i+width))}</text>`);
  };
  for(const[i,s]of state.steps.entries()){
    const y=65+i*190;card(30,y,360,s.question.text,s.question.spoken?'#dcfce7':'#f1f5f9',`第${s.index}轮 · ${s.question.spoken?'实际发声':'未发声'}`);
    if(i)shapes.push(`<path d="M210 ${y-80} V${y}" stroke="#16a34a" stroke-width="3" fill="none"/>`);
    for(const[j,c]of(s.pool?.candidates||[]).entries()){
      const x=450+j*285,selected=s.selection?.candidate?.id===c.id;
      shapes.push(`<path d="M390 ${y+55} H420 V${y-14-j*8} H${x-10} V${y+55} H${x}" stroke="${selected?'#16a34a':'#cbd5e1'}" fill="none"/>`);
      card(x,y,270,c.question,selected?'#dcfce7':'#f1f5f9',`${c.id} · ${selected?'模型选中':'未采用'}`);
    }
  }
  if(state.closing){const y=65+state.steps.length*190;shapes.push(`<path d="M210 ${y-80} V${y}" stroke="#16a34a" stroke-width="3" fill="none"/>`);card(30,y,360,state.closing.text,state.closing.spoken?'#dcfce7':'#f1f5f9','收尾');}
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="${height}" viewBox="0 0 1320 ${height}"><rect width="100%" height="100%" fill="#f8fafc"/><style>text{font-family:Arial,'PingFang SC',sans-serif;font-size:14px;fill:#1e293b}.label{font-size:12px;fill:#64748b}</style><text x="30" y="30">实际访谈树：左侧为实际问答顺序，右侧为该轮预生成的下一问候选；绿色表示采用</text>`,...shapes,...cards,'</svg>'].join('\n');
}
