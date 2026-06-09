'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Registration failed');
      }
      setSuccess(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#09090b] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-2 justify-center mb-8">
          <svg viewBox="0 0 32 32" width="32" height="32" fill="none" aria-label="QuantFlow Pro">
            <circle cx="16" cy="16" r="14" stroke="#8b5cf6" strokeWidth="2" />
            <path d="M8 20 L13 13 L18 17 L24 10" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="10" r="2" fill="#fbbf24" />
          </svg>
          <span className="font-mono text-white text-lg font-bold tracking-tight">QuantFlow Pro</span>
        </div>

        <div className="bg-[#18181b] border border-white/10 rounded-xl p-6">
          {success ? (
            <div className="text-center py-4">
              <div className="text-3xl mb-3">✓</div>
              <h2 className="text-white font-semibold mb-2">Check your email</h2>
              <p className="text-zinc-400 text-sm mb-4">
                We sent a confirmation link to <span className="text-violet-400">{email}</span>
              </p>
              <Link
                href="/login"
                className="text-violet-400 hover:text-violet-300 text-sm transition-colors"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h1 className="text-white font-semibold text-lg mb-1">Create account</h1>
              <p className="text-zinc-400 text-sm mb-6">Start monitoring institutional flow</p>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg p-3 mb-4">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-zinc-400 text-xs font-mono mb-1.5 uppercase tracking-wider">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-[#09090b] border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-violet-500 transition-colors"
                    placeholder="trader@example.com"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 text-xs font-mono mb-1.5 uppercase tracking-wider">Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-[#09090b] border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-violet-500 transition-colors"
                    placeholder="Min 8 characters"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 text-xs font-mono mb-1.5 uppercase tracking-wider">Confirm Password</label>
                  <input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full bg-[#09090b] border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-violet-500 transition-colors"
                    placeholder="Repeat password"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-mono font-semibold rounded-lg py-2.5 text-sm transition-colors"
                >
                  {loading ? 'Creating account…' : 'Create Account'}
                </button>
              </form>

              <div className="mt-4 text-center text-zinc-500 text-sm">
                Already have an account?{' '}
                <Link href="/login" className="text-violet-400 hover:text-violet-300 transition-colors">
                  Sign in
                </Link>
              </div>

              <div className="mt-4 pt-4 border-t border-white/5">
                <button
                  onClick={() => router.push('/flow')}
                  className="w-full bg-white/5 hover:bg-white/10 text-zinc-300 font-mono text-xs rounded-lg py-2 transition-colors"
                >
                  Continue as Guest (Demo Mode)
                </button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-zinc-600 text-xs mt-6 font-mono">
          Quantum Edge Capital LLC · Not investment advice
        </p>
      </div>
    </div>
  );
}
