import { useMemo, useState } from "react";
import { Search, Download, WalletCards, Bus, Landmark } from "lucide-react";
import "./App.css";

const payroll = [
  { region:"DM 1", branch:"ILORIN 2", name:"OGUNJEBE MICHEAL", gra:"83", gross:216000, bonus:0, coopS:0, coopL:0, dev:5400, tax:6480, offline:500, others:0, advance:0 },
  { region:"DM 1", branch:"ILORIN 2", name:"OKANLAWON FAIDAT.O", gra:"325", gross:136400, bonus:0, coopS:0, coopL:0, dev:3410, tax:4100, offline:0, others:0, advance:0 },
  { region:"DM 1", branch:"ILORIN 2", name:"CLEMENT EFFIONG ASUKWO", gra:"569", gross:148800, bonus:40900, coopS:0, coopL:0, dev:3720, tax:4465, offline:0, others:0, advance:0 },
  { region:"DM 1", branch:"SANGO 2", name:"ADEBIYI OLUWAKEMI", gra:"56", gross:216000, bonus:0, coopS:10000, coopL:0, dev:5400, tax:6480, offline:500, others:0, advance:0 },
  { region:"DM 1", branch:"SANGO 2", name:"BAKRIN RAHANAT R.", gra:"126", gross:163600, bonus:0, coopS:10000, coopL:0, dev:4090, tax:4910, offline:0, others:0, advance:0 },
  { region:"DM 1", branch:"SANGO 2", name:"LABA ADEWUMI OPEYEMI", gra:"152", gross:163600, bonus:0, coopS:10000, coopL:0, dev:4090, tax:4910, offline:0, others:0, advance:0 },
  { region:"DM 1", branch:"SANGO 2", name:"ADEYEMI SHITTU", gra:"603", gross:148800, bonus:0, coopS:0, coopL:0, dev:930, tax:1115, offline:0, others:0, advance:80000 },
  { region:"DM 2", branch:"AWOTAN", name:"JOSEPH RAPHAEL", gra:"64", gross:216000, bonus:54000, coopS:0, coopL:0, dev:5400, tax:6480, offline:500, others:112895, advance:0 },
  { region:"DM 2", branch:"AWOTAN", name:"ABIOLA VICTORIA", gra:"180", gross:163600, bonus:40900, coopS:0, coopL:0, dev:4090, tax:4910, offline:0, others:0, advance:0 },
  { region:"DM 2", branch:"AWOTAN", name:"OLAOLUWA NAFISAT ADEJOKE", gra:"151", gross:163600, bonus:40900, coopS:0, coopL:0, dev:4090, tax:4910, offline:0, others:0, advance:0 },
  { region:"DM 2", branch:"MONIYA 3", name:"KAYODE OLUWADAMILARE", gra:"126", gross:216000, bonus:54000, coopS:0, coopL:0, dev:5400, tax:6480, offline:500, others:142355, advance:0 },
  { region:"DM 2", branch:"AKOBO 2", name:"OMOTOSHO SHOLA MERCY", gra:"79", gross:216000, bonus:54000, coopS:0, coopL:0, dev:5400, tax:6480, offline:500, others:113045, advance:0 }
];

const transport = [
  { code:"000017", bank:"Wema/ALAT", acc:"0280064037", name:"JOSEPH ANIEBIET RAPHEAL", amount:257620, narration:"BM AWOTAN", ref:"001" },
  { code:"000017", bank:"Wema/ALAT", acc:"0261295863", name:"VICTORIA BUKOLA ABIOLA", amount:195500, narration:"AWOTAN", ref:"002" },
  { code:"000014", bank:"Access Bank", acc:"1455923913", name:"NAFISAT ADEJOKE OLAOLUWA", amount:195500, narration:"AWOTAN", ref:"003" },
  { code:"000017", bank:"Wema/ALAT", acc:"0280145332", name:"OLUWASEUN RACHEAL ADEBAYO", amount:165500, narration:"AWOTAN", ref:"004" },
  { code:"000017", bank:"Wema/ALAT", acc:"0279962919", name:"PAULINA OLUWADAMILARE KAYODE", amount:229520, narration:"BM MONIYA 3", ref:"005" },
  { code:"000010", bank:"EcoBank", acc:"2280088175", name:"AYORINDE DORCAS OYEKANMI", amount:114600, narration:"MONIYA 3", ref:"006" }
];

const cooperative = [
  { name:"BUSARI IDOWU", aprSav:65575, mayColl:10000, mayWT:0, aprLoan:343800, mayLoanColl:166700, mayLoanPaid:0 },
  { name:"BUSARI ALABA", aprSav:18245, mayColl:10000, mayWT:0, aprLoan:999600, mayLoanColl:166700, mayLoanPaid:0 },
  { name:"BOLARINWA MOTUNRAYO", aprSav:100110, mayColl:10000, mayWT:0, aprLoan:499500, mayLoanColl:166700, mayLoanPaid:0 },
  { name:"BABATUNDE FLORENCE", aprSav:195000, mayColl:5000, mayWT:0, aprLoan:250000, mayLoanColl:125000, mayLoanPaid:0 }
];

const money = n => "₦" + Number(n).toLocaleString("en-NG");
const csv = rows => rows.map(r => r.map(v => '"' + String(v ?? "").replaceAll('"','""') + '"').join(",")).join("\n");

function downloadCSV(filename, rows) {
  const blob = new Blob([csv(rows)], { type:"text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function App() {
  const [tab,setTab] = useState("payroll");
  const [region,setRegion] = useState("ALL");
  const [search,setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return payroll.filter(r =>
      (region === "ALL" || r.region === region) &&
      `${r.region} ${r.branch} ${r.name} ${r.gra}`.toLowerCase().includes(q)
    );
  },[region,search]);

  const totals = useMemo(() => filtered.reduce((t,r) => {
    const ded=r.coopS+r.coopL+r.dev+r.tax+r.offline+r.others+r.advance;
    return {...t,gross:t.gross+r.gross,bonus:t.bonus+r.bonus,coopS:t.coopS+r.coopS,coopL:t.coopL+r.coopL,dev:t.dev+r.dev,tax:t.tax+r.tax,offline:t.offline+r.offline,others:t.others+r.others,advance:t.advance+r.advance,ded:t.ded+ded,net:t.net+r.gross+r.bonus-ded};
  },{gross:0,bonus:0,coopS:0,coopL:0,dev:0,tax:0,offline:0,others:0,advance:0,ded:0,net:0}),[filtered]);

  const transportTotal=transport.reduce((s,r)=>s+r.amount,0);

  const exportCurrent=()=>{
    if(tab==="payroll") downloadCSV("pwfb-monthly-payroll.csv",[
      ["Region","Branch","Name","GRA No","Gross","Bonus","Coop.S","Coop.L","Dev 2.5%","Tax 3%","Offline","Others","Advance","Total Ded","Net Pay"],
      ...filtered.map(r=>{const d=r.coopS+r.coopL+r.dev+r.tax+r.offline+r.others+r.advance;return [r.region,r.branch,r.name,r.gra,r.gross,r.bonus,r.coopS,r.coopL,r.dev,r.tax,r.offline,r.others,r.advance,d,r.gross+r.bonus-d]})
    ]);
    if(tab==="transport") downloadCSV("pwfb-transport-salary-schedule.csv",[["Bank Code","Destination Bank","Account No","Account Name","Amount","Narration","Ref"],...transport.map(r=>[r.code,r.bank,r.acc,r.name,r.amount,r.narration,r.ref])]);
    if(tab==="coop") downloadCSV("pwfb-cooperative-ledger.csv",[["Member Name","April Sav. Bal","May S. Coll","May Sav. WT","Sav. Bal","April Loan Bal","May Loan Collec","May Loan Paid","Loan Bal"],...cooperative.map(r=>[r.name,r.aprSav,r.mayColl,r.mayWT,r.aprSav+r.mayColl-r.mayWT,r.aprLoan,r.mayLoanColl,r.mayLoanPaid,r.aprLoan+r.mayLoanColl-r.mayLoanPaid])]);
  };

  return <div className="app">
    <header className="header">
      <div className="brand">
        <svg className="logo-svg" viewBox="0 0 300 300" aria-label="PWFB logo"><rect width="300" height="300" rx="40" fill="#005C37"/><rect x="10" y="10" width="280" height="280" rx="30" fill="#F8FAFC"/><path d="M140 160C100 120 40 110 30 180C20 250 110 290 140 210Z" fill="#008751"/><path d="M160 160C200 120 260 110 270 180C280 250 190 290 160 210Z" fill="#2E6B12"/><path d="M150 70C180 70 180 120 150 120C120 120 120 70 150 70Z" fill="#F58220"/><path d="M140 130H160L170 250H130L140 130Z" fill="#F58220"/></svg>
        <div><strong>PWFB-microfinance</strong><span>Financial Portal</span></div>
      </div>
      <button className="export" onClick={exportCurrent}><Download size={16}/> Export CSV</button>
    </header>

    <main>
      <nav className="tabs">
        <button className={tab==="payroll"?"active":""} onClick={()=>setTab("payroll")}><WalletCards size={17}/> Monthly Payroll</button>
        <button className={tab==="transport"?"active":""} onClick={()=>setTab("transport")}><Bus size={17}/> Transport & Salary Schedule</button>
        <button className={tab==="coop"?"active":""} onClick={()=>setTab("coop")}><Landmark size={17}/> Co-operative Ledger</button>
      </nav>

      <section className="panel">
        <div className="toolbar">
          <div className="search"><Search size={17}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search staff, account, or branch..."/></div>
          {tab==="payroll" && <div className="filters">{["ALL","DM 1","DM 2"].map(r=><button key={r} className={region===r?"selected":""} onClick={()=>setRegion(r)}>{r==="ALL"?"All Regions":r+(r==="DM 1"?" (Region 1)":" (Region 2)")}</button>)}</div>}
        </div>

        {tab==="payroll" && <div className="table-wrap"><div className="section-head"><strong>Monthly Payroll Management (DM 1 & DM 2)</strong><span>August 2026</span></div><table><thead><tr><th>Region</th><th>Branch</th><th>Name</th><th>GRA No</th><th>Gross (1)</th><th>Bonus (2)</th><th>Coop.S (3)</th><th>Coop.L (4)</th><th>Dev 2.5% (5)</th><th>Tax 3% (6)</th><th>Offline (7)</th><th>Others (8)</th><th>Adv. (9)</th><th>Tot Ded (10)</th><th>Net Pay (11)</th></tr></thead><tbody>{filtered.map(r=>{const d=r.coopS+r.coopL+r.dev+r.tax+r.offline+r.others+r.advance;return <tr key={r.gra+"-"+r.name}><td>{r.region}</td><td><b>{r.branch}</b></td><td><b>{r.name}</b></td><td>{r.gra}</td><td>{money(r.gross)}</td><td>{money(r.bonus)}</td><td>{money(r.coopS)}</td><td>{money(r.coopL)}</td><td>{money(r.dev)}</td><td>{money(r.tax)}</td><td>{money(r.offline)}</td><td>{money(r.others)}</td><td>{money(r.advance)}</td><td className="ded">{money(d)}</td><td className="net">{money(r.gross+r.bonus-d)}</td></tr>})}</tbody><tfoot><tr><td colSpan="4">Total Summary ({region})</td><td>{money(totals.gross)}</td><td>{money(totals.bonus)}</td><td>{money(totals.coopS)}</td><td>{money(totals.coopL)}</td><td>{money(totals.dev)}</td><td>{money(totals.tax)}</td><td>{money(totals.offline)}</td><td>{money(totals.others)}</td><td>{money(totals.advance)}</td><td>{money(totals.ded)}</td><td>{money(totals.net)}</td></tr></tfoot></table></div>}

        {tab==="transport" && <div className="table-wrap"><div className="section-head"><strong>Bank Disbursement Schedule</strong><span>Batch Total: {money(11948980)}</span></div><table><thead><tr><th>Bank Code</th><th>Destination Bank</th><th>Account No</th><th>Account Name</th><th>Amount (₦)</th><th>Narration</th><th>Ref</th></tr></thead><tbody>{transport.map(r=><tr key={r.ref}><td>{r.code}</td><td><b>{r.bank}</b></td><td>{r.acc}</td><td><b>{r.name}</b></td><td className="net">{money(r.amount)}</td><td>{r.narration}</td><td>{r.ref}</td></tr>)}</tbody><tfoot><tr><td colSpan="4">Total Scheduled Disbursement</td><td>{money(11948980)}</td><td colSpan="2"></td></tr></tfoot></table></div>}

        {tab==="coop" && <div className="table-wrap"><div className="section-head"><strong>Co-operative Savings & Loan Ledger</strong><span>Sheet 84</span></div><table><thead><tr><th>Member Name</th><th>April Sav. Bal (1)</th><th>May S. Coll (2)</th><th>May Sav. WT (3)</th><th>Sav. Bal (4=1+2-3)</th><th>April Loan Bal (5)</th><th>May Loan Collec (6)</th><th>May Loan Paid (7)</th><th>Loan Bal (8=5+6-7)</th></tr></thead><tbody>{cooperative.map(r=>{const s=r.aprSav+r.mayColl-r.mayWT,l=r.aprLoan+r.mayLoanColl-r.mayLoanPaid;return <tr key={r.name}><td><b>{r.name}</b></td><td>{money(r.aprSav)}</td><td>{money(r.mayColl)}</td><td>{money(r.mayWT)}</td><td className="net">{money(s)}</td><td>{money(r.aprLoan)}</td><td>{money(r.mayLoanColl)}</td><td>{money(r.mayLoanPaid)}</td><td className="ded">{money(l)}</td></tr>})}</tbody><tfoot><tr><td>Total Portfolio</td><td>{money(cooperative.reduce((s,r)=>s+r.aprSav,0))}</td><td>{money(cooperative.reduce((s,r)=>s+r.mayColl,0))}</td><td>{money(0)}</td><td>{money(cooperative.reduce((s,r)=>s+r.aprSav+r.mayColl-r.mayWT,0))}</td><td>{money(cooperative.reduce((s,r)=>s+r.aprLoan,0))}</td><td>{money(cooperative.reduce((s,r)=>s+r.mayLoanColl,0))}</td><td>{money(0)}</td><td>{money(cooperative.reduce((s,r)=>s+r.aprLoan+r.mayLoanColl-r.mayLoanPaid,0))}</td></tr></tfoot></table></div>}
      </section>
    </main>
    <footer><span>PWFB-microfinance Financial Portal © 2026. All rights reserved.</span><span>Perfect Wisdom For Better Ltd.</span></footer>
  </div>;
}

export default App;
