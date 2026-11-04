import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { I18nProvider } from './i18n'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Keep the error boundary outermost: render failures must stay visible, never a blank page. */}
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
)
