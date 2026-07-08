import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/option/style/css';
import './styles.css';

createApp(App).use(createPinia()).mount('#app');
