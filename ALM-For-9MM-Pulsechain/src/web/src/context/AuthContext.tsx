import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { login as apiLogin, setAuthToken, setOnUnauthorized } from '../api/client';
import { useNavigate } from 'react-router-dom';

const TOKEN_KEY = 'alm_token';

interface AuthContextType {
  token: string | null;
  isAuthenticated: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) setAuthToken(stored);
    return stored;
  });
  const navigate = useNavigate();

  const logout = useCallback(() => {
    setToken(null);
    setAuthToken(null);
    localStorage.removeItem(TOKEN_KEY);
    navigate('/login');
  }, [navigate]);

  useEffect(() => {
    setOnUnauthorized(logout);
  }, [logout]);

  const login = useCallback(async (password: string) => {
    const res = await apiLogin(password);
    setToken(res.token);
    setAuthToken(res.token);
    localStorage.setItem(TOKEN_KEY, res.token);
  }, []);

  return (
    <AuthContext.Provider value={{ token, isAuthenticated: !!token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
