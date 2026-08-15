import type { LucideIcon } from "lucide-react";

interface MainContentProps {
  icon: LucideIcon;
  label: string;
  description: string;
}

function MainContent({ icon: Icon, label, description }: MainContentProps) {
  return (
    <main className="main">
      <div className="placeholder-panel">
        <Icon size={32} strokeWidth={1.5} />
        <span className="eyebrow">Module</span>
        <h2>{label}</h2>
        <p>{description}</p>
        <span className="coming-soon">Coming in a later milestone</span>
      </div>
    </main>
  );
}

export default MainContent;
