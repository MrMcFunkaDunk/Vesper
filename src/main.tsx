import "@fontsource/oxanium/500.css";
import "@fontsource/oxanium/600.css";
import "@fontsource/oxanium/700.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
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
