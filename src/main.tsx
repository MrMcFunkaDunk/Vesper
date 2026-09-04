import "@fontsource/oxanium/500.css";
import "@fontsource/oxanium/600.css";
import "@fontsource/oxanium/700.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
// Premium deck themes' own --font-display faces (Bulkhead/Cold Ballast/
// Command Deck) plus the shared --font-mono technical readout face those
// three themes' new component treatments use - see App.css's "PREMIUM DECK
// THEMES" section.
import "@fontsource/oswald/500.css";
import "@fontsource/oswald/600.css";
import "@fontsource/oswald/700.css";
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/exo-2/500.css";
import "@fontsource/exo-2/600.css";
import "@fontsource/exo-2/700.css";
import "@fontsource/saira-condensed/500.css";
import "@fontsource/saira-condensed/600.css";
import "@fontsource/saira-condensed/700.css";
import "@fontsource/share-tech-mono";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorReporterProvider } from "./hooks/useErrorReporter";
import { RecentActivityProvider } from "./hooks/useRecentActivity";
import { TrackedSystemsProvider } from "./hooks/useTrackedSystemsActivity";
import { LocationTrackingProvider } from "./hooks/useLocationTracking";
import { NotificationCenterProvider } from "./hooks/useNotificationCenter";
import { ToastProvider } from "./hooks/useToast";
import { TrackedEntitiesProvider } from "./hooks/useTrackedEntities";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorReporterProvider>
      <NotificationCenterProvider>
        <ToastProvider>
          <TrackedEntitiesProvider>
            <RecentActivityProvider>
              <TrackedSystemsProvider>
                <LocationTrackingProvider>
                  <App />
                </LocationTrackingProvider>
              </TrackedSystemsProvider>
            </RecentActivityProvider>
          </TrackedEntitiesProvider>
        </ToastProvider>
      </NotificationCenterProvider>
    </ErrorReporterProvider>
  </React.StrictMode>,
);
