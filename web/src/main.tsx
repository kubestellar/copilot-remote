import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider, BaseStyles } from '@primer/react';
import App from './App';
import './fonts.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider colorMode="night" nightScheme="dark_dimmed">
      <BaseStyles>
        <App />
      </BaseStyles>
    </ThemeProvider>
  </React.StrictMode>,
);
