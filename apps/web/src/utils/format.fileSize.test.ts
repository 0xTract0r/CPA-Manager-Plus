import { expect, it } from 'vitest';
import { formatFileSize } from './format';
it.each([
 [0,'0 B'], [1,'1.00 B'], [1024,'1.00 KB'], [1024**2,'1.00 MB'],
 [1024**3,'1.00 GB'],[1024**4,'1.00 TB'],[1024**5,'1.00 PB'],[1024**6,'1024.00 PB'],
 [0.5,'0.50 B'],[Number.MIN_VALUE,'0.00 B'],[NaN,'—'],[Infinity,'—'],[-Infinity,'—'],[-1,'—'],
] as const)('formats %s without missing units', (input, expected) => { expect(formatFileSize(input)).toBe(expected); });
it('caps finite huge values at the last unit',()=>{expect(formatFileSize(Number.MAX_VALUE)).not.toMatch(/NaN|undefined|Infinity/);expect(formatFileSize(Number.MAX_VALUE)).toMatch(/ PB$/)});
