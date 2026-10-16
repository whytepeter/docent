import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/geist-mono";
import "@fontsource/kalam/400.css";
import "@fontsource/kalam/700.css";
import "./shared/ui/tokens.css";
import "./shared/ui/base.css";
import "./shared/state/theme.ts";
import { App } from "./app/App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
