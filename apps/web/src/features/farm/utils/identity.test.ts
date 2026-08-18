import { describe, expect, it } from 'vitest';
import { maskAccountEmail, resolveBindingIdentity, stripJsonSuffix } from './identity';

describe('maskAccountEmail', () => {
  it('掩盖邮箱本地部分，保留域名', () => {
    expect(maskAccountEmail('claude@gmail.com')).toBe('cl***@gmail.com');
  });

  it('本地部分 <=2 位时用单星掩盖', () => {
    expect(maskAccountEmail('ab@gmail.com')).toBe('a*@gmail.com');
  });

  it('非邮箱字符串按首尾字符掩盖', () => {
    expect(maskAccountEmail('device-farm')).toBe('d***m');
  });

  it('空/未定义返回空串', () => {
    expect(maskAccountEmail(undefined)).toBe('');
    expect(maskAccountEmail('   ')).toBe('');
  });
});

describe('stripJsonSuffix', () => {
  it('剥掉尾部 .json（#52 尾项）', () => {
    expect(stripJsonSuffix('claude@gmail.com.json')).toBe('claude@gmail.com');
  });

  it('大小写不敏感，且 trim', () => {
    expect(stripJsonSuffix('  claude@gmail.com.JSON  ')).toBe('claude@gmail.com');
  });

  it('无 .json 后缀原样返回（trim 后）', () => {
    expect(stripJsonSuffix(' claude@gmail.com ')).toBe('claude@gmail.com');
  });

  it('只剥尾部，不误伤中间的 .json', () => {
    expect(stripJsonSuffix('a.json.b')).toBe('a.json.b');
  });

  it('空/未定义返回空串', () => {
    expect(stripJsonSuffix(undefined)).toBe('');
  });
});

describe('resolveBindingIdentity', () => {
  it('有备注名：primary=备注名，secondary=脱敏邮箱', () => {
    expect(resolveBindingIdentity('生产老号', 'claude@gmail.com')).toEqual({
      primary: '生产老号',
      secondary: 'cl***@gmail.com',
      hasNote: true,
    });
  });

  it('无备注名：primary=脱敏邮箱，secondary 空', () => {
    expect(resolveBindingIdentity(undefined, 'claude@gmail.com')).toEqual({
      primary: 'cl***@gmail.com',
      secondary: '',
      hasNote: false,
    });
  });

  it('#52 尾项：无备注名 + .json 文件名回退时剥掉 .json 再脱敏', () => {
    expect(resolveBindingIdentity(undefined, 'claude@gmail.com.json')).toEqual({
      primary: 'cl***@gmail.com',
      secondary: '',
      hasNote: false,
    });
  });

  it('#52 尾项：有备注名时 secondary 的脱敏邮箱同样剥掉 .json', () => {
    expect(resolveBindingIdentity('生产老号', 'claude@gmail.com.json')).toEqual({
      primary: '生产老号',
      secondary: 'cl***@gmail.com',
      hasNote: true,
    });
  });

  it('备注名与账号都空时 primary 为空串', () => {
    expect(resolveBindingIdentity(undefined, undefined)).toEqual({
      primary: '',
      secondary: '',
      hasNote: false,
    });
  });
});
