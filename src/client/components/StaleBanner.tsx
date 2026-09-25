/** Shared stale-data banner (final-plan §17 primitive). */
export function StaleBanner({ message }: { message: string }) {
  return (
    <div className="alert alert-warning" role="status">
      <span className="text-sm">{message}</span>
    </div>
  );
}
