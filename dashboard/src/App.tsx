import { NavLink, Route, Routes } from "react-router-dom";
import Costs from "./views/Costs";
import Frameworks from "./views/Frameworks";
import Overview from "./views/Overview";
import TransactionDetail from "./views/TransactionDetail";
import Transactions from "./views/Transactions";

export default function App() {
  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <div className="mark">D2</div>
          <div>
            <div className="name">D2D Cockpit</div>
            <div className="sub">operator console</div>
          </div>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          <NavLink to="/costs">Cost train</NavLink>
          <NavLink to="/frameworks">Frameworks</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/transactions/:id" element={<TransactionDetail />} />
          <Route path="/costs" element={<Costs />} />
          <Route path="/frameworks" element={<Frameworks />} />
        </Routes>
      </main>
    </div>
  );
}
