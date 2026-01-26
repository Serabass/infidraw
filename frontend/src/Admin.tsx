import React, { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

interface Stats {
  events: {
    total: number;
    oldest: number | null;
    newest: number | null;
  };
  snapshots: {
    total: number;
    minioObjects: number;
    minioTotalSize: number;
  };
}

function Admin() {
  const [token, setToken] = useState<string>('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [cleanupDays, setCleanupDays] = useState(30);

  useEffect(() => {
    // Проверяем сохраненный токен
    const savedToken = localStorage.getItem('admin-token');
    if (savedToken) {
      setToken(savedToken);
      setIsAuthenticated(true);
      loadStats(savedToken);
    }
  }, []);

  const loadStats = async (authToken: string) => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/admin/stats?token=${authToken}`);
      if (response.ok) {
        const data = await response.json();
        setStats(data);
        setMessage(null);
      } else {
        setIsAuthenticated(false);
        setMessage({ type: 'error', text: 'Неверный токен' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Ошибка загрузки статистики' });
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (token.trim()) {
      localStorage.setItem('admin-token', token);
      setIsAuthenticated(true);
      loadStats(token);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('admin-token');
    setToken('');
    setIsAuthenticated(false);
    setStats(null);
  };

  const handleCleanupOld = async () => {
    if (!confirm(`Удалить все записи старше ${cleanupDays} дней?`)) {
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/admin/cleanup-old`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': token,
        },
        body: JSON.stringify({ days: cleanupDays }),
      });

      const data = await response.json();
      if (response.ok) {
        setMessage({ type: 'success', text: data.message || 'Очистка выполнена успешно' });
        loadStats(token);
      } else {
        setMessage({ type: 'error', text: data.error || 'Ошибка при очистке' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Ошибка при выполнении операции' });
    } finally {
      setLoading(false);
    }
  };

  const handleCleanupAll = async () => {
    const confirmText = prompt('ВНИМАНИЕ! Это удалит ВСЁ безвозвратно!\nВведите "DELETE ALL" для подтверждения:');
    if (confirmText !== 'DELETE ALL') {
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/admin/cleanup-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': token,
        },
      });

      const data = await response.json();
      if (response.ok) {
        setMessage({ type: 'success', text: data.message || 'Полная очистка выполнена успешно' });
        loadStats(token);
      } else {
        setMessage({ type: 'error', text: data.error || 'Ошибка при очистке' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Ошибка при выполнении операции' });
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (timestamp: number | null): string => {
    if (!timestamp) return 'Нет данных';
    return new Date(timestamp).toLocaleString('ru-RU');
  };

  if (!isAuthenticated) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '12px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          minWidth: '400px'
        }}>
          <h1 style={{ marginTop: 0, marginBottom: '20px', color: '#333' }}>🔐 Админ-панель</h1>
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', color: '#666' }}>
                Токен администратора:
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Введите токен"
                style={{
                  width: '100%',
                  padding: '12px',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
                autoFocus
              />
            </div>
            <button
              type="submit"
              style={{
                width: '100%',
                padding: '12px',
                background: '#667eea',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'background 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#5568d3'}
              onMouseLeave={(e) => e.currentTarget.style.background = '#667eea'}
            >
              Войти
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', padding: '20px' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <div style={{
          background: 'white',
          padding: '30px',
          borderRadius: '12px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          marginBottom: '20px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
            <h1 style={{ margin: 0, color: '#333' }}>🛠️ Админ-панель</h1>
            <button
              onClick={handleLogout}
              style={{
                padding: '8px 16px',
                background: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              Выйти
            </button>
          </div>

          {message && (
            <div style={{
              padding: '12px',
              borderRadius: '6px',
              marginBottom: '20px',
              background: message.type === 'success' ? '#d4edda' : '#f8d7da',
              color: message.type === 'success' ? '#155724' : '#721c24',
              border: `1px solid ${message.type === 'success' ? '#c3e6cb' : '#f5c6cb'}`
            }}>
              {message.text}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '30px' }}>
            <div style={{
              background: '#f8f9fa',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #dee2e6'
            }}>
              <h3 style={{ marginTop: 0, color: '#495057' }}>📊 Статистика</h3>
              {loading && !stats ? (
                <div>Загрузка...</div>
              ) : stats ? (
                <div>
                  <div style={{ marginBottom: '15px' }}>
                    <strong>События:</strong>
                    <div style={{ marginLeft: '10px', marginTop: '5px' }}>
                      <div>Всего: {stats.events.total.toLocaleString()}</div>
                      <div style={{ fontSize: '12px', color: '#666' }}>
                        Старейшее: {formatDate(stats.events.oldest)}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666' }}>
                        Новейшее: {formatDate(stats.events.newest)}
                      </div>
                    </div>
                  </div>
                  <div>
                    <strong>Снапшоты:</strong>
                    <div style={{ marginLeft: '10px', marginTop: '5px' }}>
                      <div>Всего: {stats.snapshots.total.toLocaleString()}</div>
                      <div>Объектов в MinIO: {stats.snapshots.minioObjects.toLocaleString()}</div>
                      <div>Размер: {formatBytes(stats.snapshots.minioTotalSize)}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => loadStats(token)}
                    style={{
                      marginTop: '15px',
                      padding: '6px 12px',
                      background: '#007bff',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px'
                    }}
                    disabled={loading}
                  >
                    🔄 Обновить
                  </button>
                </div>
              ) : (
                <div>Нет данных</div>
              )}
            </div>

            <div style={{
              background: '#fff3cd',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #ffc107'
            }}>
              <h3 style={{ marginTop: 0, color: '#856404' }}>🧹 Очистка старых записей</h3>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold' }}>
                  Удалить записи старше (дней):
                </label>
                <input
                  type="number"
                  value={cleanupDays}
                  onChange={(e) => setCleanupDays(parseInt(e.target.value) || 30)}
                  min="1"
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              <button
                onClick={handleCleanupOld}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '10px',
                  background: '#ffc107',
                  color: '#856404',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  opacity: loading ? 0.6 : 1
                }}
              >
                {loading ? 'Выполняется...' : 'Удалить старые записи'}
              </button>
            </div>

            <div style={{
              background: '#f8d7da',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #dc3545'
            }}>
              <h3 style={{ marginTop: 0, color: '#721c24' }}>⚠️ Опасная зона</h3>
              <p style={{ fontSize: '14px', color: '#721c24', marginBottom: '15px' }}>
                <strong>ВНИМАНИЕ!</strong> Эта операция удалит ВСЁ безвозвратно:
                <ul style={{ marginTop: '10px', paddingLeft: '20px' }}>
                  <li>Все события (strokes)</li>
                  <li>Все снапшоты тайлов</li>
                  <li>Все объекты в MinIO</li>
                  <li>Данные в Redis</li>
                </ul>
              </p>
              <button
                onClick={handleCleanupAll}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '10px',
                  background: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  opacity: loading ? 0.6 : 1
                }}
              >
                {loading ? 'Выполняется...' : '🗑️ Очистить ВСЁ'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Admin;
