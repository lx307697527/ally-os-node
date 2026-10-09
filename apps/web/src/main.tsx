import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installErrorReporter } from "./shared/lib/error-reporter.ts";
import "./index.css";

// Global error capture (#28): best-effort reports to the API, wired once
// before anything else can throw. Fire-and-forget — see error-reporter.ts.
installErrorReporter(window);

const queryClient = new QueryClient();
const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
