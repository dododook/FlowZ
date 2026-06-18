export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="font-display text-2xl font-bold">{title}</h2>
      {description && <p className="text-muted-foreground mt-1">{description}</p>}
    </div>
  );
}
