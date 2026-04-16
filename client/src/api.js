import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 45000,
});

// 请求拦截器：始终尝试从 localStorage 获取最新的 adminPassword
api.interceptors.request.use(config => {
  const pwd = localStorage.getItem('adminPassword');
  if (pwd) {
    config.headers['Authorization'] = `Bearer ${pwd}`;
  }
  // Ensure we are not sending undefined or empty strings that could confuse the backend
  return config;
}, error => {
  return Promise.reject(error);
});

export const getAuthHeaders = () => {
    const pwd = localStorage.getItem('adminPassword');
    return pwd ? { 'Authorization': `Bearer ${pwd}` } : {};
};

export default api;
