import { Icon, Logo } from "../../shared/ui/index.ts";
import "./workspace.css";

/** While the first request is in flight. Shown only after a beat, so a fast server never flashes it. */
export function Booting({ label = "Starting Docent…" }: { label?: string }) {
  return (
    <div className="bd-home boot">
      <div className="boot-wait" role="status"><span className="spinner" aria-hidden="true" />{label}</div>
    </div>
  );
}

/** The web app loaded but its server didn't answer. */
export function ServerDown({ message }: { message: string }) {
  return (
    <div className="bd-home boot">
      <section className="boot-card" role="alert">
        <Logo size={22} />
        <h1>Can’t reach the Docent server</h1>
        <p>Start it from the docent folder with <code>pnpm dev</code>, then try again.</p>
        <p className="boot-err">{message}</p>
        <button className="open-choose" onClick={() => window.location.reload()} autoFocus>
          <Icon name="refresh" size={16} />Try again
        </button>
      </section>
    </div>
  );
}
