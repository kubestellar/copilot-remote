import ReactDOM from 'react-dom/client';
import { ThemeProvider, BaseStyles } from '@primer/react';
import App from './App';
import './fonts.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider colorMode="night" nightScheme="dark_dimmed">
    <BaseStyles>
      <App />
    </BaseStyles>
  </ThemeProvider>,
);
