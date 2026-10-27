export default function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">{phase} 交付，当前版本先打通拓扑管理。</p>
    </section>
  );
}
