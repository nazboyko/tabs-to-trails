import './fonts';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Header } from './common';
import { useRoute } from './router';
import { Home } from './screens/Home';
import { Script } from './screens/Script';
import { Walk } from './screens/Walk';

function App() {
  const route = useRoute();
  return (
    <>
      <Header />
      <main id="main">
        {route.name === 'build' && <Home />}
        {route.name === 'walk' && <Walk id={route.id} key={route.id} />}
        {route.name === 'script' && <Script id={route.id} key={`s-${route.id}`} />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
