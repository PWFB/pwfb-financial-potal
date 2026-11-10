import {useEffect,useState} from "react";
import html2canvas from "html2canvas";
import {jsPDF} from "jspdf";

export default function ReportTools({targetRef,filename="pwfb-daily-report"}){
 const [busy,setBusy]=useState(""),[message,setMessage]=useState(""),[pdfUrl,setPdfUrl]=useState(""),[pdfName,setPdfName]=useState("");
 useEffect(()=>()=>{if(pdfUrl)URL.revokeObjectURL(pdfUrl)},[pdfUrl]);
 const capture=async()=>{
  const node=targetRef?.current;
  if(!node)throw new Error("The report is not ready to export.");
  await document.fonts?.ready;
  node.classList.add("report-exporting");
  try{
   const width=Math.max(node.scrollWidth,node.clientWidth,320);
   const height=Math.max(node.scrollHeight,node.clientHeight,200);
   const scale=Math.min(2,Math.sqrt(18000000/(width*height)));
   return await html2canvas(node,{backgroundColor:document.body.dataset.theme==="dark"?"#0f172a":"#ffffff",scale:Math.max(1,scale),useCORS:true,allowTaint:false,logging:false,windowWidth:width,windowHeight:height,width,height,scrollX:0,scrollY:0});
  }finally{node.classList.remove("report-exporting")}
 };
 const saveImage=async()=>{
  setBusy("image");setMessage("");
  try{
   const canvas=await capture();
   const blob=await new Promise((resolve,reject)=>canvas.toBlob(v=>v?resolve(v):reject(new Error("Image export could not be created.")),"image/png"));
   const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename+".png";document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
   setMessage("Report image saved.");
  }catch(e){setMessage(e.message||"Image export failed.")}finally{setBusy("")}
 };
 const savePdf=async()=>{
  setBusy("pdf");setMessage("");
  try{
   const canvas=await capture();
   const orientation=canvas.width>canvas.height?"landscape":"portrait";
   const pdf=new jsPDF({orientation,unit:"pt",format:"a4",compress:true});
   const margin=22,pageW=pdf.internal.pageSize.getWidth(),pageH=pdf.internal.pageSize.getHeight(),usableW=pageW-margin*2,usableH=pageH-margin*2;
   const pxPerPt=canvas.width/usableW,sliceHeight=Math.max(1,Math.floor(usableH*pxPerPt));
   let page=0;
   for(let y=0;y<canvas.height;y+=sliceHeight){
    const height=Math.min(sliceHeight,canvas.height-y),slice=document.createElement("canvas");slice.width=canvas.width;slice.height=height;
    const ctx=slice.getContext("2d");if(!ctx)throw new Error("Unable to prepare a PDF page.");
    ctx.drawImage(canvas,0,y,canvas.width,height,0,0,canvas.width,height);
    if(page>0)pdf.addPage("a4",orientation);
    pdf.addImage(slice.toDataURL("image/jpeg",0.94),"JPEG",margin,margin,usableW,height/pxPerPt,undefined,"FAST");
    page++;
   }
   pdf.save(filename+".pdf");setMessage("PDF downloaded and fitted to A4 pages.");
  }catch(e){setMessage(e.message||"PDF export failed.")}finally{setBusy("")}
 };
 const choosePdf=event=>{
  const file=event.target.files?.[0];event.target.value="";
  if(!file)return;
  if(file.type!=="application/pdf"&&!file.name.toLowerCase().endsWith(".pdf")){setMessage("Please select a PDF file.");return}
  if(file.size>30*1024*1024){setMessage("PDF is larger than 30 MB. Choose a smaller file.");return}
  const next=URL.createObjectURL(file);setPdfUrl(old=>{if(old)URL.revokeObjectURL(old);return next});setPdfName(file.name);setMessage("PDF loaded for in-page preview. This preview is local to this browser session.");
 };
 return <div className="report-tools no-print">
  <div className="report-tools-buttons">
   <button type="button" onClick={saveImage} disabled={!!busy}>{busy==="image"?"Creating image…":"Save page image"}</button>
   <button type="button" onClick={savePdf} disabled={!!busy}>{busy==="pdf"?"Creating PDF…":"Download PDF"}</button>
   <button type="button" onClick={()=>window.print()} disabled={!!busy}>Print page</button>
   <label className="report-upload-button">Upload PDF<input type="file" accept="application/pdf,.pdf" onChange={choosePdf}/></label>
   {pdfUrl&&<a className="report-upload-download" href={pdfUrl} download={pdfName}>Download uploaded PDF</a>}
  </div>
  {message&&<p className="report-tools-message" role="status">{message}</p>}
  {pdfUrl&&<section className="report-upload-preview"><div><strong>Uploaded PDF preview</strong><span>{pdfName}</span><button type="button" onClick={()=>{URL.revokeObjectURL(pdfUrl);setPdfUrl("");setPdfName("");setMessage("Uploaded PDF preview removed.")}}>Remove preview</button></div><iframe src={pdfUrl+"#view=FitH&toolbar=1"} title={"PDF preview: "+pdfName}/></section>}
 </div>
}
