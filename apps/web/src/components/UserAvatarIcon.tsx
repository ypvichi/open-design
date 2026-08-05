import { useMemo } from 'react';
import { getStoredUsername } from '../auth/auth';

interface UserAvatarIconProps {
  size?: number;
}

// 预定义的深色背景色板（确保对比度足够，白色文字可读）
const DARK_COLORS = [
  '#1a237e', // 深蓝
  '#004d40', // 深青
  '#3e2723', // 深棕
  '#263238', // 深灰
  '#4a148c', // 深紫
  '#b71c1c', // 深红
  '#1b5e20', // 深绿
  '#0d47a1', // 深蓝
  '#311b92', // 深靛
  '#bf360c', // 深橙
];

function getColorFromUsername(username: string) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % DARK_COLORS.length;
  return DARK_COLORS[index];
}

function getInitial(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

/**
 * 用户头像图标组件
 * 显示用户名首字母大写，圆形，随机深色背景，白色文字
 */
export function UserAvatarIcon({ size = 32 }: UserAvatarIconProps) {
  const username = getStoredUsername();

  const { initial, bgColor } = useMemo(() => {
    if (!username) {
      return { initial: '?', bgColor: '#37474f' };
    }
    return {
      initial: getInitial(username),
      bgColor: getColorFromUsername(username),
    };
  }, [username]);

  return (
    <div
      className="user-avatar-icon"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: bgColor,
        color: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: `${size * 0.5}px`,
        fontWeight: 600,
        lineHeight: 1,
        userSelect: 'none',
        flexShrink: 0,
      }}
      aria-label={`用户 ${username || '未知'}`}
      title={username || '未知用户'}
    >
      {initial}
    </div>
  );
}
