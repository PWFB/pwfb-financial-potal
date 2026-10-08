import { useMemo, useState } from "react";
import {
  Search,
  Download,
  WalletCards,
  Bus,
  Landmark,
  ChevronDown,
  TrendingUp,
  Users,
  CircleDollarSign
} from "lucide-react";
import "./App.css";

const payroll = [
  { name: "Aisha Bello", id: "PWFB-001", region: "DM 1", gross: 185000, bonus: 25000, coop: 15000, dev: 4625, tax: 5550, offline: 0, others: 2000, advance: 0 },
  { name: "Ibrahim Musa", id: "PWFB-002", region: "DM 1", gross: 210000, bonus: 30000, coop: 20000, dev: 5250, tax: 6300, offline: 0, others: 3500, advance: 15000 },
  { name: "Grace Okafor", id: "PWFB-003", region: "DM 2", gross: 195000, bonus: 20000, coop: 18000, dev: 4875, tax: 5850, offline: 2500, others: 1500, advance: 0 },
  { name: "Daniel Adeyemi", id: "PWFB-004", region: "DM 2", gross: 240000, bonus: 35000, coop: 25000, dev: 6000, tax: 7200, offline: 0, others: 4000, advance: 20000 }
];

const transfers = [
  { staff: "Aisha Bello", bank: "GTBank", account: "0123456789", amount: 182825, status: "Scheduled" },
  { staff: "Ibrahim Musa", bank: "Access Bank", account: "0987654321", amount: 174950, status: "Pending" },
  { staff: "Grace Okafor", bank: "UBA", account: "1122334455", amount: 182275, status: "Scheduled" },
  { staff: "Daniel Adeyemi", bank: "Zenith Bank", account: "5566778899", amount: 207925, status: "Paid" }
];

const cooperative = [
  { member: "Aisha Bello", savings: 85000, loan: 120000, repayment: 45000 },
  { member: "Ibrahim Musa", savings: 120000, loan: 200000, repayment: 80000 },
  { member: "Grace Okafor", savings: 95000, loan: 150000, repayment: 60000 },
  { member: "Daniel Adeyemi", savings: 150000, loan: 250000, repayment: 100000 }
];

const money = n =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0
  }).format(n);

function App() {
  const [tab, setTab] = useState("payroll");
  const [region, setRegion] = useState("All");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return payroll.filter(p =>
      (region === "All" || p.region === region) &&
      `${p.name} ${p.id} ${p.region}`.toLowerCase().includes(q)
    );
  }, [region, search]);

  const totals = useMemo(() => ({
    gross: filtered.reduce((s, p) => s + p.gross + p.bonus, 0),
    deductions: filtered.reduce((s, p) => s + p.coop + p.dev + p.tax + p.offline + p.others + p.advance, 0)
  }), [filtered]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="logo">P</div>
          <div>
            <strong>PWFB-microfinance</strong>
            <span>Financial Portal</span>
          </div>
        </div>

        <div className="header-actions">
          <div className="status-dot">● Live</div>
          <div className="admin">Administrator</div>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">FINANCIAL OPERATIONS</p>
            <h1>Financial Portal</h1>
            <p>Manage payroll, salary disbursement and cooperative records from one secure workspace.</p>
          </div>
          <button className="export" onClick={() => window.print()}>
            <Download size={17} /> Export
          </button>
        </section>

        <section className="stats">
          <div className="stat">
            <div className="icon"><Users size={20}/></div>
            <span>Staff Records</span>
            <strong>{payroll.length}</strong>
          </div>
          <div className="stat">
            <div className="icon"><CircleDollarSign size={20}/></div>
            <span>Gross Payroll</span>
            <strong>{money(totals.gross)}</strong>
          </div>
          <div className="stat">
            <div className="icon"><WalletCards size={20}/></div>
            <span>Total Deductions</span>
            <strong>{money(totals.deductions)}</strong>
          </div>
          <div className="stat">
            <div className="icon"><TrendingUp size={20}/></div>
            <span>Net Payroll</span>
            <strong>{money(totals.gross - totals.deductions)}</strong>
          </div>
        </section>

        <nav className="tabs">
          <button className={tab === "payroll" ? "active" : ""} onClick={() => setTab("payroll")}>
            <WalletCards size={18}/> Monthly Payroll
          </button>
          <button className={tab === "transport" ? "active" : ""} onClick={() => setTab("transport")}>
            <Bus size={18}/> Transport & Salary Schedule
          </button>
          <button className={tab === "coop" ? "active" : ""} onClick={() => setTab("coop")}>
            <Landmark size={18}/> Co-operative Ledger
          </button>
        </nav>

        <section className="panel">
          <div className="toolbar">
            <div className="search">
              <Search size={18}/>
              <input
                placeholder="Search staff, account or reference..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            {tab === "payroll" && (
              <div className="filters">
                {["All", "DM 1", "DM 2"].map(r => (
                  <button key={r} className={region === r ? "selected" : ""} onClick={() => setRegion(r)}>
                    {r}<ChevronDown size={14}/>
                  </button>
                ))}
              </div>
            )}
          </div>

          {tab === "payroll" && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Staff</th><th>Region</th><th>Gross</th><th>Bonus</th>
                    <th>Co-op</th><th>Dev. 2.5%</th><th>Tax 3%</th>
                    <th>Offline</th><th>Others</th><th>Advance</th><th>Total Ded.</th><th>Net Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(p => {
                    const deductions = p.coop + p.dev + p.tax + p.offline + p.others + p.advance;
                    const net = p.gross + p.bonus - deductions;
                    return (
                      <tr key={p.id}>
                        <td><strong>{p.name}</strong><small>{p.id}</small></td>
                        <td><span className="badge">{p.region}</span></td>
                        <td>{money(p.gross)}</td><td>{money(p.bonus)}</td>
                        <td>{money(p.coop)}</td><td>{money(p.dev)}</td><td>{money(p.tax)}</td>
                        <td>{money(p.offline)}</td><td>{money(p.others)}</td><td>{money(p.advance)}</td>
                        <td className="ded">{money(deductions)}</td>
                        <td className="net">{money(net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === "transport" && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Staff</th><th>Bank</th><th>Account Number</th><th>Amount</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {transfers.map((x, i) => (
                    <tr key={i}>
                      <td><strong>{x.staff}</strong></td>
                      <td>{x.bank}</td>
                      <td>{x.account}</td>
                      <td className="net">{money(x.amount)}</td>
                      <td><span className={`status ${x.status.toLowerCase()}`}>{x.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "coop" && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Member</th><th>Savings Balance</th><th>Loan</th><th>Repayment</th><th>Outstanding Loan</th></tr>
                </thead>
                <tbody>
                  {cooperative.map((x, i) => (
                    <tr key={i}>
                      <td><strong>{x.member}</strong></td>
                      <td className="net">{money(x.savings)}</td>
                      <td>{money(x.loan)}</td>
                      <td>{money(x.repayment)}</td>
                      <td className="ded">{money(x.loan - x.repayment)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <footer>
        <span>© {new Date().getFullYear()} Perfect Wisdom For Better Ltd. (PWFB)</span>
        <span>Secure Financial Operations</span>
      </footer>
    </div>
  );
}

export default App;
