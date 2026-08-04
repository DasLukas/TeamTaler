import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { de } from './locales/de';

void i18n.use(initReactI18next).init({
  lng: 'de',
  fallbackLng: 'de',
  interpolation: { escapeValue: false },
  resources: {
    de: {
      translation: de,
    },
  },
});

/** Initialized TeamTaler i18next instance shared by React and non-React modules. */
export default i18n;
