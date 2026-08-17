import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#5965e8',
          colorText: '#1f2430',
          borderRadius: 10,
          fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        },
        components: {
          Button: { controlHeight: 38 },
          Input: { controlHeight: 38 },
          Select: { controlHeight: 38 },
          Table: { headerBg: '#f8f9fc', headerColor: '#687083' }
        }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
