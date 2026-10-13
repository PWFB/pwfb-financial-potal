import { StrictMode, Component } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const rootElement = document.getElementById('root');
const root = createRoot(rootElement);

function StartupMessage({ title, message, onReload }) {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '24px', background: '#f7faf8', color: '#173b2b', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(100%, 520px)', boxSizing: 'border-box', padding: '28px', background: '#fff', border: '1px solid #dce9df', borderRadius: '18px', boxShadow: '0 16px 48px #173b2b12' }}>
        <div style={{ width: '52px', height: '52px', display: 'grid', placeItems: 'center', borderRadius: '15px', background: '#005c37', color: '#fff', fontWeight: 900, fontSize: '18px' }}>PWFB</div>
        <p style={{ margin: '22px 0 8px', color: '#f58220', fontWeight: 800, letterSpacing: '1px', fontSize: '11px' }}>PWFB FINANCIAL POTAL</p>
        <h1 style={{ margin: '0 0 12px', fontSize: '25px' }}>{title}</h1>
        <p style={{ margin: 0, lineHeight: 1.6, color: '#52645a' }}>{message}</p>
        <button onClick={onReload} style={{ marginTop: '22px', width: '100%', border: 0, borderRadius: '10px', padding: '13px 16px', background: '#f58220', color: '#fff', fontWeight: 800, fontSize: '15px' }}>Reload page</button>
      </section>
    </main>
  );
}

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error('PWFB app render failed:', error);
    this.setState({ message: error?.message || 'An unexpected rendering error occurred.' });
  }
  render() {
    if (this.state.failed) {
      return <StartupMessage title="The portal could not open" message={this.state.message || 'A page error stopped the portal from opening. Reload the page or contact the administrator if it continues.'} onReload={() => window.location.reload()} />;
    }
    return this.props.children;
  }
}

root.render(
  <StartupMessage title="Opening your secure portal…" message="Please wait while the login screen loads." onReload={() => window.location.reload()} />
);

import('./App.jsx')
  .then(({ default: App }) => {
    root.render(
      <StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </StrictMode>
    );
  })
  .catch((error) => {
    console.error('PWFB app startup failed:', error);
    root.render(
      <StartupMessage
        title="The portal could not start"
        message={error?.message || 'The application failed to load. Please reload and try again.'}
        onReload={() => window.location.reload()}
      />
    );
  });
