import StatusChip from "./StatusChip";

interface DashboardProps {
  characterName: string;
}

function Dashboard({ characterName }: DashboardProps) {
  return (
    <main className="main">
      <div className="dashboard-panel">
        <p className="eyebrow">Operations Overview</p>
        <h2>Welcome back, {characterName}</h2>
        <StatusChip label={characterName} value="Connected" tone="online" />
        <p className="dashboard-note">
          Module summaries will appear here as each system comes online.
        </p>
      </div>
    </main>
  );
}

export default Dashboard;
