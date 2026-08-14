interface TopBarProps {
  title: string;
}

function TopBar({ title }: TopBarProps) {
  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-account">
        <span className="status-dot" />
        Not signed in
      </div>
    </header>
  );
}

export default TopBar;
