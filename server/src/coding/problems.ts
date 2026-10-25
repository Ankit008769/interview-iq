import type { FunctionProblem, Problem, Rng, SqlProblem } from './types.js';

// Curated coding problems (roadmap C2 v1). Expected answers for function problems come from the reference
// solution, so every hidden and generated test is consistent with it; references are self-contained so the
// verification script can submit them to the runner as JavaScript. Large generated inputs separate efficient
// solutions from brute force. SQL answers are written out by hand and checked against the reference query.
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const ints = (rng: Rng, n: number, lo: number, hi: number) => Array.from({ length: n }, () => int(rng, lo, hi));
const word = (rng: Rng, n: number, alphabet: string) => Array.from({ length: n }, () => alphabet[int(rng, 0, alphabet.length - 1)]).join('');
const shuffle = <T>(rng: Rng, list: T[]) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = int(rng, 0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sortedDistinct = (rng: Rng, n: number) => { const a: number[] = []; let x = -1_000_000; for (let i = 0; i < n; i++) { x += int(rng, 1, 15); a.push(x); } return a; };

const algorithms: FunctionProblem[] = [
  {
    kind: 'algorithm', id: 'two-sum', title: 'Two Sum', difficulty: 'Beginner', topics: ['Arrays', 'Hashing'],
    statement: 'Given an array of integers `nums` and an integer `target`, return the indices of the two numbers that add up to `target`, smaller index first.\n\nEach input has exactly one solution, and you may not use the same element twice.',
    constraints: ['2 ≤ nums.length ≤ 10^5', '-10^9 ≤ nums[i], target ≤ 10^9', 'Exactly one valid answer exists.'],
    signature: { name: 'twoSum', params: [{ name: 'nums', type: 'int[]' }, { name: 'target', type: 'int' }], returns: 'int[]' },
    examples: [{ args: [[2, 7, 11, 15], 9], explanation: 'nums[0] + nums[1] = 2 + 7 = 9.' }, { args: [[3, 2, 4], 6] }, { args: [[3, 3], 6] }],
    tests: [[[1, 5], 6], [[-3, 4, 3, 90], 0], [[0, 4, 3, 0], 0], [[5, 75, 25], 100], [[1000000000, -999999993, 3], 7]],
    // Multiples of 4 plus one value of each residue 1 and 2: their sum is the only pair with residue 3.
    generate: rng => [0, 1].map(() => {
      const nums = ints(rng, 100_000, -250_000_000, 250_000_000).map(x => x * 4);
      const a = int(rng, -100_000_000, 100_000_000) * 4 + 1, b = int(rng, -100_000_000, 100_000_000) * 4 + 2;
      const i = int(rng, 0, nums.length - 1); let j = int(rng, 0, nums.length - 1); if (j === i) j = (i + 1) % nums.length;
      nums[i] = a; nums[j] = b; return [nums, a + b];
    }),
    reference: (nums: number[], target: number) => {
      const seen = new Map<number, number>();
      for (let i = 0; i < nums.length; i++) {
        const j = seen.get(target - nums[i]);
        if (j !== undefined) return [j, i];
        seen.set(nums[i], i);
      }
      return [];
    },
    timeLimitMs: 1000, complexity: 'O(n) time and O(n) space with a hash map from value to index; the O(n²) pair check times out on the largest tests.',
  },
  {
    kind: 'algorithm', id: 'valid-parentheses', title: 'Valid Parentheses', difficulty: 'Beginner', topics: ['Stacks', 'Strings'],
    statement: 'Given a string `s` containing only the characters `()[]{}`, return whether it is valid: every opening bracket is closed by a bracket of the same type, in the correct order.',
    constraints: ['1 ≤ s.length ≤ 10^5'],
    signature: { name: 'isValid', params: [{ name: 's', type: 'string' }], returns: 'bool' },
    examples: [{ args: ['()'] }, { args: ['()[]{}'] }, { args: ['(]'], explanation: 'The round bracket is closed by a square one.' }, { args: ['([])'] }],
    tests: [['('], [')'], ['{[]}'], ['(('], ['){'], ['[({})]'], ['[(])'], ['(((())))'], [']']],
    generate: rng => {
      const pairs = ['()', '[]', '{}'];
      const balanced = (n: number) => { const out: string[] = []; const stack: string[] = [];
        while (out.length + stack.length < n) { if (stack.length && (rng() < 0.5 || out.length + stack.length * 2 >= n)) out.push(stack.pop()!); else { const p = pairs[int(rng, 0, 2)]; out.push(p[0]); stack.push(p[1]); } }
        while (stack.length) out.push(stack.pop()!); return out.join(''); };
      const good = balanced(100_000);
      return [['('.repeat(50_000) + ')'.repeat(50_000)], [good], [good.slice(0, -1) + (good.endsWith(')') ? ']' : ')')]];
    },
    reference: (s: string) => {
      const close: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
      const stack: string[] = [];
      for (const c of s) {
        if (c in close) { if (stack.pop() !== close[c]) return false; } else stack.push(c);
      }
      return stack.length === 0;
    },
    timeLimitMs: 800, complexity: 'O(n) time with a stack of open brackets; O(n) space.',
  },
  {
    kind: 'algorithm', id: 'maximum-subarray', title: 'Maximum Subarray', difficulty: 'Intermediate', topics: ['Arrays', 'Dynamic programming'],
    statement: 'Given an integer array `nums`, return the largest sum of any non-empty contiguous subarray.',
    constraints: ['1 ≤ nums.length ≤ 10^5', '-10^4 ≤ nums[i] ≤ 10^4'],
    signature: { name: 'maxSubArray', params: [{ name: 'nums', type: 'int[]' }], returns: 'int' },
    examples: [{ args: [[-2, 1, -3, 4, -1, 2, 1, -5, 4]], explanation: 'The subarray [4, -1, 2, 1] has the largest sum, 6.' }, { args: [[1]] }, { args: [[5, 4, -1, 7, 8]] }],
    tests: [[[-1]], [[-3, -1, -2]], [[0, 0, 0]], [[2, -1, 2]], [[-2, -3, 4, -1, -2, 1, 5, -3]]],
    generate: rng => [[ints(rng, 100_000, -10_000, 10_000)], [ints(rng, 100_000, -10_000, 10_000)], [ints(rng, 100_000, -10_000, -1)]],
    reference: (nums: number[]) => {
      let best = nums[0], current = 0;
      for (const x of nums) { current = Math.max(x, current + x); best = Math.max(best, current); }
      return best;
    },
    timeLimitMs: 800, complexity: 'O(n) time and O(1) space with Kadane\'s algorithm; checking every subarray is O(n²) and times out.',
  },
  {
    kind: 'algorithm', id: 'merge-intervals', title: 'Merge Intervals', difficulty: 'Intermediate', topics: ['Sorting', 'Intervals'],
    statement: 'Given an array of `intervals` where `intervals[i] = [start, end]`, merge all overlapping intervals and return the intervals that remain, sorted by start.\n\nIntervals that touch, such as [1, 4] and [4, 5], overlap.',
    constraints: ['1 ≤ intervals.length ≤ 10^5', '0 ≤ start ≤ end ≤ 10^6'],
    signature: { name: 'merge', params: [{ name: 'intervals', type: 'int[][]' }], returns: 'int[][]' },
    examples: [{ args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], explanation: '[1, 3] and [2, 6] overlap, so they become [1, 6].' }, { args: [[[1, 4], [4, 5]]] }],
    tests: [[[[1, 4]]], [[[1, 4], [0, 4]]], [[[1, 4], [2, 3]]], [[[5, 6], [1, 2], [3, 4]]], [[[1, 10], [2, 3], [4, 5], [11, 12]]], [[[0, 0], [0, 0]]]],
    generate: rng => [0, 1].map(() => [Array.from({ length: 100_000 }, () => { const s = int(rng, 0, 1_000_000 - 30); return [s, s + int(rng, 0, 30)]; })]),
    reference: (intervals: number[][]) => {
      const sorted = intervals.map(i => [i[0], i[1]]).sort((a, b) => a[0] - b[0]);
      const out: number[][] = [];
      for (const [s, e] of sorted) {
        const last = out[out.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
      }
      return out;
    },
    timeLimitMs: 1500, complexity: 'O(n log n) time to sort by start, then one merging pass; O(n) space for the result.',
  },
  {
    kind: 'algorithm', id: 'binary-search', title: 'Binary Search', difficulty: 'Beginner', topics: ['Binary search', 'Arrays'],
    statement: 'Given a sorted array of distinct integers `nums` and a `target`, return the index of `target`, or -1 if it is not in the array. Aim for O(log n) time.',
    constraints: ['1 ≤ nums.length ≤ 10^5', 'nums is sorted in increasing order and has no duplicates'],
    signature: { name: 'search', params: [{ name: 'nums', type: 'int[]' }, { name: 'target', type: 'int' }], returns: 'int' },
    examples: [{ args: [[-1, 0, 3, 5, 9, 12], 9], explanation: '9 is at index 4.' }, { args: [[-1, 0, 3, 5, 9, 12], 2] }],
    tests: [[[5], 5], [[5], -5], [[1, 2], 2], [[1, 3, 5, 7], 1], [[1, 3, 5, 7], 8], [[1, 3, 5, 7], 0]],
    generate: rng => { const a = sortedDistinct(rng, 100_000); return [[a, a[int(rng, 0, a.length - 1)]], [a, a[0] - 1], [a, a[a.length - 1]]]; },
    reference: (nums: number[], target: number) => {
      let lo = 0, hi = nums.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (nums[mid] === target) return mid;
        if (nums[mid] < target) lo = mid + 1; else hi = mid - 1;
      }
      return -1;
    },
    timeLimitMs: 800, complexity: 'O(log n) time by halving the search range each step; a linear scan is O(n).',
  },
  {
    kind: 'algorithm', id: 'climbing-stairs', title: 'Climbing Stairs', difficulty: 'Beginner', topics: ['Dynamic programming', 'Recursion'],
    statement: 'You are climbing a staircase with `n` steps. Each time you can climb 1 or 2 steps. In how many distinct ways can you reach the top?',
    constraints: ['1 ≤ n ≤ 70', 'The answer fits in a 64-bit integer.'],
    signature: { name: 'climbStairs', params: [{ name: 'n', type: 'int' }], returns: 'long' },
    examples: [{ args: [2], explanation: '1 + 1, or 2.' }, { args: [3], explanation: '1 + 1 + 1, 1 + 2, or 2 + 1.' }],
    tests: [[1], [4], [5], [10], [30], [45], [60], [70]],
    reference: (n: number) => { let a = 1, b = 1; for (let i = 2; i <= n; i++) [a, b] = [b, a + b]; return b; },
    timeLimitMs: 800, complexity: 'O(n) time and O(1) space by iterating the Fibonacci recurrence; plain recursion is exponential and times out for n = 70.',
  },
  {
    kind: 'algorithm', id: 'product-except-self', title: 'Product of Array Except Self', difficulty: 'Intermediate', topics: ['Arrays', 'Prefix sums'],
    statement: 'Given an integer array `nums`, return an array `answer` where `answer[i]` is the product of every element of `nums` except `nums[i]`.\n\nDo not use division. Every product fits in a 32-bit signed integer.',
    constraints: ['2 ≤ nums.length ≤ 10^5', '-30 ≤ nums[i] ≤ 30'],
    signature: { name: 'productExceptSelf', params: [{ name: 'nums', type: 'int[]' }], returns: 'int[]' },
    examples: [{ args: [[1, 2, 3, 4]] }, { args: [[-1, 1, 0, -3, 3]] }],
    tests: [[[2, 3]], [[0, 0]], [[0, 4, 5]], [[-1, -1, -1]], [[1, 1, 1, 1, 1]], [[2, -3, 4, -5]]],
    generate: rng => {
      const base = () => { const a: number[] = Array.from({ length: 100_000 }, () => (rng() < 0.5 ? -1 : 1)); for (let k = 0; k < 20; k++) a[int(rng, 0, a.length - 1)] = 2; return a; };
      const withZero = base(); withZero[int(rng, 0, withZero.length - 1)] = 0;
      return [[base()], [withZero]];
    },
    reference: (nums: number[]) => {
      const out = new Array<number>(nums.length).fill(1);
      let left = 1; for (let i = 0; i < nums.length; i++) { out[i] = left; left *= nums[i]; }
      let right = 1; for (let i = nums.length - 1; i >= 0; i--) { out[i] = (out[i] * right) || 0; right *= nums[i]; }
      return out;
    },
    timeLimitMs: 1000, complexity: 'O(n) time with prefix and suffix products and O(1) extra space besides the output; the nested-loop O(n²) approach times out.',
  },
  {
    kind: 'algorithm', id: 'longest-substring-without-repeats', title: 'Longest Substring Without Repeating Characters', difficulty: 'Intermediate', topics: ['Strings', 'Sliding window'],
    statement: 'Given a string `s`, return the length of the longest substring (a contiguous run of characters) that has no repeated character.',
    constraints: ['0 ≤ s.length ≤ 10^5', 's contains printable ASCII characters'],
    signature: { name: 'lengthOfLongestSubstring', params: [{ name: 's', type: 'string' }], returns: 'int' },
    examples: [{ args: ['abcabcbb'], explanation: '"abc" has length 3.' }, { args: ['bbbbb'] }, { args: ['pwwkew'], explanation: '"wke" has length 3; "pwke" is not contiguous.' }],
    tests: [[''], [' '], ['au'], ['dvdf'], ['abba'], ['tmmzuxt'], ['abcdefghijklmnopqrstuvwxyz']],
    generate: rng => [[word(rng, 100_000, 'abcdefghijklmnopqrstuvwxyz')], [Array.from({ length: 100_000 }, () => String.fromCharCode(int(rng, 32, 126))).join('')]],
    reference: (s: string) => {
      const last = new Map<string, number>();
      let best = 0, start = 0;
      for (let i = 0; i < s.length; i++) {
        const seen = last.get(s[i]);
        if (seen !== undefined && seen >= start) start = seen + 1;
        last.set(s[i], i);
        best = Math.max(best, i - start + 1);
      }
      return best;
    },
    timeLimitMs: 1000, complexity: 'O(n) time with a sliding window and a map of each character\'s last position; checking every substring is O(n²) or worse.',
  },
  {
    kind: 'algorithm', id: 'valid-anagram', title: 'Valid Anagram', difficulty: 'Beginner', topics: ['Hashing', 'Strings'],
    statement: 'Given two strings `s` and `t`, return whether `t` is an anagram of `s`: it uses exactly the same letters, each the same number of times.',
    constraints: ['1 ≤ s.length, t.length ≤ 5 × 10^4', 's and t contain lowercase English letters'],
    signature: { name: 'isAnagram', params: [{ name: 's', type: 'string' }, { name: 't', type: 'string' }], returns: 'bool' },
    examples: [{ args: ['anagram', 'nagaram'] }, { args: ['rat', 'car'] }],
    tests: [['a', 'a'], ['a', 'b'], ['ab', 'a'], ['aacc', 'ccac'], ['listen', 'silent']],
    generate: rng => { const s = word(rng, 50_000, 'abcdefghijklmnopqrstuvwxyz'); const t = shuffle(rng, [...s]); const changed = [...t]; changed[0] = changed[0] === 'a' ? 'b' : 'a';
      return [[s, t.join('')], [s, changed.join('')]]; },
    reference: (s: string, t: string) => {
      if (s.length !== t.length) return false;
      const counts = new Map<string, number>();
      for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
      for (const c of t) { const n = counts.get(c) ?? 0; if (n === 0) return false; counts.set(c, n - 1); }
      return true;
    },
    timeLimitMs: 800, complexity: 'O(n) time by counting letters, or O(n log n) by sorting both strings.',
  },
  {
    kind: 'algorithm', id: 'top-k-frequent', title: 'Top K Frequent Elements', difficulty: 'Intermediate', topics: ['Hashing', 'Heaps', 'Sorting'],
    statement: 'Given an integer array `nums` and an integer `k`, return the `k` most frequent elements, in any order. The answer is unique.',
    constraints: ['1 ≤ nums.length ≤ 10^5', '1 ≤ k ≤ number of distinct values'],
    signature: { name: 'topKFrequent', params: [{ name: 'nums', type: 'int[]' }, { name: 'k', type: 'int' }], returns: 'int[]' },
    compare: 'unordered',
    examples: [{ args: [[1, 1, 1, 2, 2, 3], 2], explanation: '1 appears three times and 2 twice.' }, { args: [[1], 1] }],
    tests: [[[4, 4, 4, 5, 5, 6, 6, 6, 6], 1], [[-1, -1, 2, 2, 2, 3], 2], [[7, 8, 9, 7, 8, 7], 3]],
    generate: rng => {
      const values = shuffle(rng, Array.from({ length: 446 }, (_, i) => i * 7 - 1500));
      const nums = shuffle(rng, values.flatMap((v, i) => new Array<number>(i + 1).fill(v)));
      return [[nums, 10], [nums, 1]];
    },
    reference: (nums: number[], k: number) => {
      const counts = new Map<number, number>();
      for (const x of nums) counts.set(x, (counts.get(x) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, k).map(([v]) => v);
    },
    timeLimitMs: 1000, complexity: 'O(n log n) by sorting the counts, or O(n) with buckets indexed by frequency; O(n) space for the counts.',
  },
  {
    kind: 'algorithm', id: 'number-of-islands', title: 'Number of Islands', difficulty: 'Intermediate', topics: ['Graphs', 'BFS/DFS', 'Matrices'],
    statement: '`grid` is a map of `1` (land) and `0` (water), given as one string per row. An island is a group of land cells connected horizontally or vertically. Return the number of islands.',
    constraints: ['1 ≤ rows, columns ≤ 300', 'The largest grids are one big island, so deep recursion can overflow: an explicit stack or queue is safer.'],
    signature: { name: 'numIslands', params: [{ name: 'grid', type: 'string[]' }], returns: 'int' },
    examples: [{ args: [['11110', '11010', '11000', '00000']] }, { args: [['11000', '11000', '00100', '00011']] }],
    tests: [[['0']], [['1']], [['10', '01']], [['111', '010', '111']], [['1011', '0001', '1101']]],
    generate: rng => [[Array.from({ length: 300 }, () => word(rng, 300, '01'))], [Array.from({ length: 300 }, () => '1'.repeat(300))]],
    reference: (grid: string[]) => {
      const rows = grid.length, cols = grid[0].length;
      const seen = new Uint8Array(rows * cols);
      let islands = 0;
      for (let start = 0; start < rows * cols; start++) {
        if (seen[start] || grid[Math.floor(start / cols)][start % cols] !== '1') continue;
        islands++; seen[start] = 1;
        const queue = [start];
        for (let q = 0; q < queue.length; q++) {
          const r = Math.floor(queue[q] / cols), c = queue[q] % cols;
          for (const [nr, nc] of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]]) {
            if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
            const cell = nr * cols + nc;
            if (!seen[cell] && grid[nr][nc] === '1') { seen[cell] = 1; queue.push(cell); }
          }
        }
      }
      return islands;
    },
    timeLimitMs: 1500, complexity: 'O(rows × columns) time, visiting every cell once with BFS or DFS; an explicit queue or stack avoids recursion limits on large islands.',
  },
  {
    kind: 'algorithm', id: 'coin-change', title: 'Coin Change', difficulty: 'Intermediate', topics: ['Dynamic programming'],
    statement: 'Given coin denominations `coins` and an `amount`, return the fewest coins that add up to `amount`, or -1 if it cannot be made. You have an unlimited number of each coin.',
    constraints: ['1 ≤ coins.length ≤ 12', '1 ≤ coins[i] ≤ 10^4', '0 ≤ amount ≤ 10^4'],
    signature: { name: 'coinChange', params: [{ name: 'coins', type: 'int[]' }, { name: 'amount', type: 'int' }], returns: 'int' },
    examples: [{ args: [[1, 2, 5], 11], explanation: '11 = 5 + 5 + 1.' }, { args: [[2], 3] }, { args: [[1], 0] }],
    tests: [[[2, 5, 10, 1], 27], [[186, 419, 83, 408], 6249], [[3, 7], 5], [[5], 10000], [[1], 10000], [[1, 3, 4], 6]],
    generate: rng => [[ints(rng, 12, 1, 500), 10_000], [[7, 13, 29], 9_999]],
    reference: (coins: number[], amount: number) => {
      const best = new Array<number>(amount + 1).fill(Infinity);
      best[0] = 0;
      for (let a = 1; a <= amount; a++) for (const c of coins) if (c <= a && best[a - c] + 1 < best[a]) best[a] = best[a - c] + 1;
      return best[amount] === Infinity ? -1 : best[amount];
    },
    timeLimitMs: 1500, complexity: 'O(amount × coins) time with bottom-up dynamic programming over amounts; always taking the largest coin is wrong for coin sets such as [1, 3, 4].',
  },
  {
    kind: 'algorithm', id: 'longest-common-prefix', title: 'Longest Common Prefix', difficulty: 'Beginner', topics: ['Strings'],
    statement: 'Return the longest string that is a prefix of every string in `strs`, or an empty string if there is none.',
    constraints: ['1 ≤ strs.length ≤ 10^4', '0 ≤ strs[i].length ≤ 200', 'strs[i] contains lowercase English letters'],
    signature: { name: 'longestCommonPrefix', params: [{ name: 'strs', type: 'string[]' }], returns: 'string' },
    examples: [{ args: [['flower', 'flow', 'flight']] }, { args: [['dog', 'racecar', 'car']], explanation: 'There is no common prefix.' }],
    tests: [[['']], [['a']], [['ab', 'a']], [['prefix', 'prefixes', 'prefixed']], [['same', 'same']]],
    generate: rng => { const prefix = word(rng, 50, 'abc'); return [[Array.from({ length: 10_000 }, () => prefix + word(rng, int(rng, 0, 20), 'xyz'))]]; },
    reference: (strs: string[]) => {
      let prefix = strs[0];
      for (const s of strs) { let i = 0; while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++; prefix = prefix.slice(0, i); }
      return prefix;
    },
    timeLimitMs: 1000, complexity: 'O(S) time, where S is the total number of characters, comparing character by character and stopping at the first mismatch.',
  },
  {
    kind: 'algorithm', id: 'move-zeroes', title: 'Move Zeroes', difficulty: 'Beginner', topics: ['Arrays', 'Two pointers'],
    statement: 'Move every 0 in `nums` to the end while keeping the relative order of the other elements, and return the array. Try to do it in place.',
    constraints: ['1 ≤ nums.length ≤ 10^5', '-2^31 ≤ nums[i] ≤ 2^31 − 1'],
    signature: { name: 'moveZeroes', params: [{ name: 'nums', type: 'int[]' }], returns: 'int[]' },
    examples: [{ args: [[0, 1, 0, 3, 12]] }, { args: [[0]] }],
    tests: [[[1, 2, 3]], [[0, 0, 1]], [[4, 0, 5, 0, 6]], [[-1, 0, -2]]],
    generate: rng => [[Array.from({ length: 100_000 }, () => (rng() < 0.3 ? 0 : int(rng, -1000, 1000) || 1))]],
    reference: (nums: number[]) => {
      const out = [...nums];
      let write = 0;
      for (const x of out.slice()) if (x !== 0) out[write++] = x;
      while (write < out.length) out[write++] = 0;
      return out;
    },
    timeLimitMs: 800, complexity: 'O(n) time and O(1) extra space with a write pointer; removing and appending zeros one at a time is O(n²).',
  },
  {
    kind: 'algorithm', id: 'kth-largest', title: 'Kth Largest Element', difficulty: 'Intermediate', topics: ['Heaps', 'Sorting', 'Quickselect'],
    statement: 'Given an integer array `nums` and an integer `k`, return the `k`th largest element (in sorted order, so duplicates count).',
    constraints: ['1 ≤ k ≤ nums.length ≤ 10^5', '-10^4 ≤ nums[i] ≤ 10^4'],
    signature: { name: 'findKthLargest', params: [{ name: 'nums', type: 'int[]' }, { name: 'k', type: 'int' }], returns: 'int' },
    examples: [{ args: [[3, 2, 1, 5, 6, 4], 2] }, { args: [[3, 2, 3, 1, 2, 4, 5, 5, 6], 4] }],
    tests: [[[1], 1], [[2, 1], 2], [[7, 7, 7], 2], [[-1, -5, 3, 9], 1], [[-1, -5, 3, 9], 4]],
    generate: rng => { const a = ints(rng, 100_000, -10_000, 10_000); return [[a, 50_000], [a, 1]]; },
    reference: (nums: number[], k: number) => [...nums].sort((a, b) => b - a)[k - 1],
    timeLimitMs: 1200, complexity: 'O(n log k) with a min-heap of size k, or O(n) on average with quickselect; sorting in O(n log n) also passes.',
  },
  {
    kind: 'algorithm', id: 'valid-palindrome', title: 'Valid Palindrome', difficulty: 'Beginner', topics: ['Strings', 'Two pointers'],
    statement: 'Return whether `s` reads the same forwards and backwards after converting letters to lower case and removing every character that is not an ASCII letter or digit.',
    constraints: ['1 ≤ s.length ≤ 2 × 10^5', 's contains printable ASCII characters'],
    signature: { name: 'isPalindrome', params: [{ name: 's', type: 'string' }], returns: 'bool' },
    examples: [{ args: ['A man, a plan, a canal: Panama'] }, { args: ['race a car'] }, { args: [' '], explanation: 'After removing other characters the string is empty, which reads the same both ways.' }],
    tests: [['0P'], ['ab_a'], ['Madam'], ["No 'x' in Nixon"], ['.,'], ['abcd']],
    generate: rng => { const half = Array.from({ length: 50_000 }, () => word(rng, 1, 'abcXYZ019') + (rng() < 0.2 ? ',' : '')).join('');
      return [[half + [...half].reverse().join('')], [half + 'q' + [...half].reverse().join('') + 'w']]; },
    reference: (s: string) => {
      const kept = s.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (let i = 0, j = kept.length - 1; i < j; i++, j--) if (kept[i] !== kept[j]) return false;
      return true;
    },
    timeLimitMs: 800, complexity: 'O(n) time and O(1) extra space with two pointers that skip characters other than letters and digits.',
  },
  {
    kind: 'algorithm', id: 'missing-number', title: 'Missing Number', difficulty: 'Beginner', topics: ['Math', 'Bit manipulation'],
    statement: '`nums` contains n distinct numbers from the range [0, n], so exactly one number in the range is missing. Return it.',
    constraints: ['1 ≤ n ≤ 10^5'],
    signature: { name: 'missingNumber', params: [{ name: 'nums', type: 'int[]' }], returns: 'int' },
    examples: [{ args: [[3, 0, 1]], explanation: 'n = 3, and 2 is missing from [0, 3].' }, { args: [[0, 1]] }, { args: [[9, 6, 4, 2, 3, 5, 7, 0, 1]] }],
    tests: [[[0]], [[1]], [[1, 2]], [[2, 0]]],
    generate: rng => { const n = 100_000; const missing = int(rng, 0, n); return [[shuffle(rng, Array.from({ length: n + 1 }, (_, i) => i).filter(i => i !== missing))]]; },
    reference: (nums: number[]) => { const n = nums.length; let sum = (n * (n + 1)) / 2; for (const x of nums) sum -= x; return sum; },
    timeLimitMs: 800, complexity: 'O(n) time and O(1) space using the sum formula or XOR; sorting first is O(n log n).',
  },
  {
    kind: 'algorithm', id: 'merge-sorted-arrays', title: 'Merge Sorted Arrays', difficulty: 'Beginner', topics: ['Arrays', 'Two pointers'],
    statement: 'Given two integer arrays `a` and `b`, each sorted in non-decreasing order, return one sorted array containing all of their elements.',
    constraints: ['0 ≤ a.length, b.length ≤ 5 × 10^4'],
    signature: { name: 'mergeSorted', params: [{ name: 'a', type: 'int[]' }, { name: 'b', type: 'int[]' }], returns: 'int[]' },
    examples: [{ args: [[1, 2, 4], [1, 3, 4]] }, { args: [[], [0]] }],
    tests: [[[], []], [[5], []], [[1, 1], [1]], [[-5, 0, 5], [-6, 6]]],
    generate: rng => [[ints(rng, 50_000, -1e6, 1e6).sort((x, y) => x - y), ints(rng, 50_000, -1e6, 1e6).sort((x, y) => x - y)]],
    reference: (a: number[], b: number[]) => {
      const out: number[] = []; let i = 0, j = 0;
      while (i < a.length || j < b.length) out.push(j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++]);
      return out;
    },
    timeLimitMs: 800, complexity: 'O(n + m) time with two pointers; concatenating and sorting is O((n + m) log(n + m)).',
  },
  {
    kind: 'algorithm', id: 'longest-increasing-subsequence', title: 'Longest Increasing Subsequence', difficulty: 'Advanced', topics: ['Dynamic programming', 'Binary search'],
    statement: 'Return the length of the longest strictly increasing subsequence of `nums`. A subsequence keeps the original order but may skip elements.\n\nThe largest tests have 10^5 elements, so they need better than O(n²).',
    constraints: ['1 ≤ nums.length ≤ 10^5', '-10^9 ≤ nums[i] ≤ 10^9'],
    signature: { name: 'lengthOfLIS', params: [{ name: 'nums', type: 'int[]' }], returns: 'int' },
    examples: [{ args: [[10, 9, 2, 5, 3, 7, 101, 18]], explanation: 'One longest subsequence is [2, 3, 7, 101].' }, { args: [[0, 1, 0, 3, 2, 3]] }, { args: [[7, 7, 7, 7]] }],
    tests: [[[1]], [[5, 4, 3, 2, 1]], [[1, 2, 3, 4, 5]], [[3, 10, 2, 1, 20]], [[4, 10, 4, 3, 8, 9]]],
    generate: rng => [[ints(rng, 100_000, -1e9, 1e9)], [Array.from({ length: 100_000 }, (_, i) => i * 10 + int(rng, -15, 15))]],
    reference: (nums: number[]) => {
      const tails: number[] = [];
      for (const x of nums) {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < x) lo = mid + 1; else hi = mid; }
        tails[lo] = x;
      }
      return tails.length;
    },
    timeLimitMs: 1500, complexity: 'O(n log n) time with patience sorting: keep the smallest tail of an increasing subsequence of each length and binary search it; the O(n²) DP times out on the largest tests.',
  },
  {
    kind: 'algorithm', id: 'house-robber', title: 'House Robber', difficulty: 'Intermediate', topics: ['Dynamic programming'],
    statement: 'Each house on a street holds `nums[i]` rupees. You cannot take from two adjacent houses. Return the most you can collect.',
    constraints: ['1 ≤ nums.length ≤ 10^5', '0 ≤ nums[i] ≤ 400'],
    signature: { name: 'rob', params: [{ name: 'nums', type: 'int[]' }], returns: 'int' },
    examples: [{ args: [[1, 2, 3, 1]], explanation: 'Take houses 0 and 2: 1 + 3 = 4.' }, { args: [[2, 7, 9, 3, 1]] }],
    tests: [[[5]], [[2, 1]], [[0, 0, 0]], [[2, 1, 1, 2]], [[10, 1, 1, 10, 1]]],
    generate: rng => [[ints(rng, 100_000, 0, 400)]],
    reference: (nums: number[]) => { let take = 0, skip = 0; for (const x of nums) [take, skip] = [skip + x, Math.max(take, skip)]; return Math.max(take, skip); },
    timeLimitMs: 800, complexity: 'O(n) time and O(1) space with two running totals (best with and without the current house); trying every subset is exponential.',
  },
  {
    kind: 'algorithm', id: 'spiral-matrix', title: 'Spiral Matrix', difficulty: 'Intermediate', topics: ['Matrices', 'Simulation'],
    statement: 'Return all elements of `matrix` in spiral order: along the top row, down the right column, back along the bottom row, up the left column, and so on inwards.',
    constraints: ['1 ≤ rows, columns ≤ 300'],
    signature: { name: 'spiralOrder', params: [{ name: 'matrix', type: 'int[][]' }], returns: 'int[]' },
    examples: [{ args: [[[1, 2, 3], [4, 5, 6], [7, 8, 9]]] }, { args: [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]] }],
    tests: [[[[1]]], [[[1, 2]]], [[[1], [2]]], [[[1, 2], [3, 4]]], [[[1, 2, 3], [4, 5, 6]]]],
    generate: rng => [[Array.from({ length: 300 }, () => ints(rng, 300, -100, 100))], [Array.from({ length: 200 }, () => ints(rng, 7, 0, 9))]],
    reference: (matrix: number[][]) => {
      const out: number[] = [];
      let top = 0, bottom = matrix.length - 1, left = 0, right = matrix[0].length - 1;
      while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++) out.push(matrix[top][c]);
        for (let r = top + 1; r <= bottom; r++) out.push(matrix[r][right]);
        if (top < bottom) for (let c = right - 1; c >= left; c--) out.push(matrix[bottom][c]);
        if (left < right) for (let r = bottom - 1; r > top; r--) out.push(matrix[r][left]);
        top++; bottom--; left++; right--;
      }
      return out;
    },
    timeLimitMs: 1000, complexity: 'O(rows × columns) time by walking layer by layer with four shrinking boundaries.',
  },
  {
    kind: 'algorithm', id: 'meeting-rooms', title: 'Meeting Rooms', difficulty: 'Advanced', topics: ['Sorting', 'Heaps', 'Intervals'],
    statement: 'Each meeting is `[start, end]` and occupies its room from `start` up to, but not including, `end`. Return the minimum number of rooms needed so that no two meetings in the same room overlap.\n\nA meeting that starts exactly when another ends can use the same room.',
    constraints: ['1 ≤ intervals.length ≤ 10^5', '0 ≤ start < end ≤ 10^6'],
    signature: { name: 'minMeetingRooms', params: [{ name: 'intervals', type: 'int[][]' }], returns: 'int' },
    examples: [{ args: [[[0, 30], [5, 10], [15, 20]]] }, { args: [[[7, 10], [2, 4]]] }],
    tests: [[[[1, 5]]], [[[1, 5], [5, 10]]], [[[1, 5], [2, 6], [3, 7]]], [[[9, 10], [4, 9], [4, 17]]]],
    generate: rng => [[Array.from({ length: 100_000 }, () => { const s = int(rng, 0, 999_000); return [s, s + int(rng, 1, 1000)]; })]],
    reference: (intervals: number[][]) => {
      const starts = intervals.map(i => i[0]).sort((a, b) => a - b);
      const ends = intervals.map(i => i[1]).sort((a, b) => a - b);
      let rooms = 0, best = 0, e = 0;
      for (const s of starts) { while (ends[e] <= s) { e++; rooms--; } rooms++; best = Math.max(best, rooms); }
      return best;
    },
    timeLimitMs: 1500, complexity: 'O(n log n) time by sorting start and end times and sweeping, or with a min-heap of end times.',
  },
  {
    kind: 'algorithm', id: 'course-schedule', title: 'Course Schedule', difficulty: 'Advanced', topics: ['Graphs', 'Topological sort'],
    statement: 'There are `numCourses` courses labelled 0 to numCourses − 1. `prerequisites[i] = [a, b]` means you must take course b before course a. Return whether you can finish every course.',
    constraints: ['1 ≤ numCourses ≤ 10^5', '0 ≤ prerequisites.length ≤ 10^5', 'The largest tests are long chains, so deep recursion can overflow.'],
    signature: { name: 'canFinish', params: [{ name: 'numCourses', type: 'int' }, { name: 'prerequisites', type: 'int[][]' }], returns: 'bool' },
    examples: [{ args: [2, [[1, 0]]], explanation: 'Take course 0, then course 1.' }, { args: [2, [[1, 0], [0, 1]]], explanation: 'Each course needs the other first.' }],
    tests: [[1, []], [3, [[1, 0], [2, 1]]], [3, [[0, 1], [1, 2], [2, 0]]], [4, [[1, 0], [2, 0], [3, 1], [3, 2]]], [2, [[0, 0]]]],
    generate: () => { const n = 100_000; const chain = Array.from({ length: n - 1 }, (_, i) => [i + 1, i]); return [[n, chain], [n, [...chain, [0, n - 1]]]]; },
    reference: (numCourses: number, prerequisites: number[][]) => {
      const indegree = new Array<number>(numCourses).fill(0);
      const next: number[][] = Array.from({ length: numCourses }, () => []);
      for (const [a, b] of prerequisites) { next[b].push(a); indegree[a]++; }
      const queue = indegree.flatMap((d, i) => (d === 0 ? [i] : []));
      for (let q = 0; q < queue.length; q++) for (const a of next[queue[q]]) if (--indegree[a] === 0) queue.push(a);
      return queue.length === numCourses;
    },
    timeLimitMs: 1500, complexity: 'O(V + E) time with a topological sort (Kahn\'s algorithm or DFS cycle detection); an iterative approach avoids recursion limits on long chains.',
  },
  {
    kind: 'algorithm', id: 'edit-distance', title: 'Edit Distance', difficulty: 'Advanced', topics: ['Dynamic programming', 'Strings'],
    statement: 'Return the minimum number of single-character insertions, deletions or substitutions needed to turn `word1` into `word2`.',
    constraints: ['0 ≤ word1.length, word2.length ≤ 1000', 'Both words contain lowercase English letters'],
    signature: { name: 'minDistance', params: [{ name: 'word1', type: 'string' }, { name: 'word2', type: 'string' }], returns: 'int' },
    examples: [{ args: ['horse', 'ros'], explanation: 'horse → rorse (replace h) → rose (delete r) → ros (delete e).' }, { args: ['intention', 'execution'] }],
    tests: [['', ''], ['a', ''], ['', 'abc'], ['abc', 'abc'], ['kitten', 'sitting'], ['flaw', 'lawn']],
    generate: rng => [[word(rng, 1000, 'abcd'), word(rng, 1000, 'abcd')]],
    reference: (word1: string, word2: string) => {
      let prev = Array.from({ length: word2.length + 1 }, (_, j) => j);
      for (let i = 1; i <= word1.length; i++) {
        const row = [i];
        for (let j = 1; j <= word2.length; j++) row[j] = word1[i - 1] === word2[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
        prev = row;
      }
      return prev[word2.length];
    },
    timeLimitMs: 2000, complexity: 'O(n × m) time with dynamic programming over prefixes, and O(min(n, m)) space with a rolling row; plain recursion is exponential.',
  },
  {
    kind: 'algorithm', id: 'daily-temperatures', title: 'Daily Temperatures', difficulty: 'Intermediate', topics: ['Stacks', 'Monotonic stack'],
    statement: 'Given daily `temperatures`, return an array where each entry is the number of days until a warmer temperature, or 0 if no warmer day follows.',
    constraints: ['1 ≤ temperatures.length ≤ 10^5', '0 ≤ temperatures[i] ≤ 10^5'],
    signature: { name: 'dailyTemperatures', params: [{ name: 'temperatures', type: 'int[]' }], returns: 'int[]' },
    examples: [{ args: [[73, 74, 75, 71, 69, 72, 76, 73]] }, { args: [[30, 40, 50, 60]] }, { args: [[30, 60, 90]] }],
    tests: [[[50]], [[50, 50]], [[60, 50, 40]], [[40, 50, 40, 50]]],
    generate: rng => [[[...Array.from({ length: 99_999 }, (_, i) => 99_999 - i), 100_000]], [ints(rng, 100_000, 30, 100)]],
    reference: (temperatures: number[]) => {
      const out = new Array<number>(temperatures.length).fill(0);
      const stack: number[] = [];
      temperatures.forEach((t, i) => { while (stack.length && temperatures[stack[stack.length - 1]] < t) { const j = stack.pop()!; out[j] = i - j; } stack.push(i); });
      return out;
    },
    timeLimitMs: 1000, complexity: 'O(n) time with a monotonic stack of days still waiting for a warmer one; scanning ahead from every day is O(n²) in the worst case.',
  },
  {
    kind: 'algorithm', id: 'trapping-rain-water', title: 'Trapping Rain Water', difficulty: 'Advanced', topics: ['Two pointers', 'Arrays'],
    statement: 'Given non-negative bar heights `height`, each bar 1 unit wide, return how much rain water is trapped between the bars.\n\nThe answer can be larger than a 32-bit integer.',
    constraints: ['1 ≤ height.length ≤ 10^5', '0 ≤ height[i] ≤ 10^5'],
    signature: { name: 'trap', params: [{ name: 'height', type: 'int[]' }], returns: 'long' },
    examples: [{ args: [[0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]] }, { args: [[4, 2, 0, 3, 2, 5]] }],
    tests: [[[1]], [[2, 0, 2]], [[3, 0, 0, 2, 0, 4]], [[5, 4, 3, 2, 1]], [[1, 2, 3]]],
    generate: rng => [[ints(rng, 100_000, 0, 100_000)], [[100_000, ...new Array<number>(99_998).fill(0), 100_000]]],
    reference: (height: number[]) => {
      let i = 0, j = height.length - 1, leftMax = 0, rightMax = 0, water = 0;
      while (i < j) {
        if (height[i] < height[j]) { leftMax = Math.max(leftMax, height[i]); water += leftMax - height[i]; i++; }
        else { rightMax = Math.max(rightMax, height[j]); water += rightMax - height[j]; j--; }
      }
      return water;
    },
    timeLimitMs: 1000, complexity: 'O(n) time and O(1) space with two pointers (or O(n) space with prefix maxima); the total needs a 64-bit integer.',
  },
  {
    kind: 'algorithm', id: 'group-anagrams', title: 'Group Anagrams', difficulty: 'Intermediate', topics: ['Hashing', 'Strings'],
    statement: 'Group the strings in `strs` that are anagrams of each other. Return the groups in any order; the strings within a group may also be in any order.',
    constraints: ['1 ≤ strs.length ≤ 2 × 10^4', '0 ≤ strs[i].length ≤ 100', 'strs[i] contains lowercase English letters'],
    signature: { name: 'groupAnagrams', params: [{ name: 'strs', type: 'string[]' }], returns: 'string[][]' },
    compare: 'unordered-nested',
    examples: [{ args: [['eat', 'tea', 'tan', 'ate', 'nat', 'bat']] }, { args: [['']] }, { args: [['a']] }],
    tests: [[['ab', 'ba', 'abc']], [['abc', 'bca', 'cab', 'xyz']], [['', '']]],
    generate: rng => [[Array.from({ length: 20_000 }, () => word(rng, 5, 'abcde'))]],
    reference: (strs: string[]) => {
      const groups = new Map<string, string[]>();
      for (const s of strs) { const key = [...s].sort().join(''); const g = groups.get(key); if (g) g.push(s); else groups.set(key, [s]); }
      return [...groups.values()];
    },
    timeLimitMs: 1500, complexity: 'O(n × k log k) time by using each word\'s sorted letters as a hash-map key, or O(n × k) by counting letters.',
  },
];

const debugging: FunctionProblem[] = [
  {
    kind: 'debugging', id: 'debug-average', title: 'Fix: Average of a List', difficulty: 'Beginner', topics: ['Debugging', 'Arrays'],
    statement: 'This function should return the average of `nums`, or 0 when `nums` is empty. It has bugs. Run the examples, read what fails, and fix it.',
    constraints: ['0 ≤ nums.length ≤ 10^5', '-1000 ≤ nums[i] ≤ 1000'],
    signature: { name: 'average', params: [{ name: 'nums', type: 'int[]' }], returns: 'double' },
    languages: ['javascript', 'typescript', 'python'],
    starter: {
      javascript: 'function average(nums) {\n  let total = 0;\n  for (let i = 0; i <= nums.length; i++) {\n    total += nums[i];\n  }\n  return total / nums.length;\n}\n',
      typescript: 'function average(nums: number[]): number {\n  let total = 0;\n  for (let i = 0; i <= nums.length; i++) {\n    total += nums[i];\n  }\n  return total / nums.length;\n}\n',
      python: 'def average(nums: list[int]) -> float:\n    total = 0\n    for i in range(1, len(nums)):\n        total += nums[i]\n    return total // len(nums)\n',
    },
    examples: [{ args: [[1, 2, 3, 4]] }, { args: [[]], explanation: 'An empty list has average 0.' }],
    tests: [[[5]], [[-1, 1]], [[1, 2]], [[10, 20, 30]], [[-3, -4]]],
    generate: rng => [[ints(rng, 100_000, -1000, 1000)]],
    reference: (nums: number[]) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0),
    timeLimitMs: 800, complexity: 'O(n) time in one pass; the bugs are an off-by-one loop bound, integer division and the empty case.',
  },
  {
    kind: 'debugging', id: 'debug-dedupe-sorted', title: 'Fix: Remove Duplicates from a Sorted List', difficulty: 'Beginner', topics: ['Debugging', 'Arrays'],
    statement: 'Given a list sorted in non-decreasing order, this function should return each distinct value once, in order. It has a bug. Find and fix it.',
    constraints: ['0 ≤ nums.length ≤ 10^5'],
    signature: { name: 'dedupeSorted', params: [{ name: 'nums', type: 'int[]' }], returns: 'int[]' },
    languages: ['javascript', 'typescript', 'python'],
    starter: {
      javascript: 'function dedupeSorted(nums) {\n  const result = [];\n  for (let i = 1; i < nums.length; i++) {\n    if (nums[i] !== nums[i - 1]) {\n      result.push(nums[i]);\n    }\n  }\n  return result;\n}\n',
      typescript: 'function dedupeSorted(nums: number[]): number[] {\n  const result: number[] = [];\n  for (let i = 1; i < nums.length; i++) {\n    if (nums[i] !== nums[i - 1]) {\n      result.push(nums[i]);\n    }\n  }\n  return result;\n}\n',
      python: 'def dedupe_sorted(nums: list[int]) -> list[int]:\n    result = []\n    for i in range(len(nums) - 1):\n        if nums[i] != nums[i + 1]:\n            result.append(nums[i])\n    return result\n',
    },
    examples: [{ args: [[1, 1, 2]] }, { args: [[0, 0, 1, 1, 1, 2, 2, 3, 3, 4]] }],
    tests: [[[]], [[7]], [[1, 2, 3]], [[2, 2, 2]], [[-3, -3, 0, 5, 5]]],
    generate: rng => [[ints(rng, 100_000, -5000, 5000).sort((a, b) => a - b)]],
    reference: (nums: number[]) => nums.filter((x, i) => i === 0 || x !== nums[i - 1]),
    timeLimitMs: 800, complexity: 'O(n) time in one pass comparing each value with the previous one; the bug drops the first (JavaScript) or last (Python) value.',
  },
  {
    kind: 'debugging', id: 'debug-is-prime', title: 'Fix: Prime Check', difficulty: 'Beginner', topics: ['Debugging', 'Math'],
    statement: 'This function should return whether `n` is a prime number. It gives wrong answers for some inputs. Find the bugs and fix them.',
    constraints: ['-10^9 ≤ n ≤ 2 × 10^9'],
    signature: { name: 'isPrime', params: [{ name: 'n', type: 'int' }], returns: 'bool' },
    languages: ['javascript', 'typescript', 'python'],
    starter: {
      javascript: 'function isPrime(n) {\n  for (let i = 2; i * i < n; i++) {\n    if (n % i === 0) return false;\n  }\n  return true;\n}\n',
      typescript: 'function isPrime(n: number): boolean {\n  for (let i = 2; i * i < n; i++) {\n    if (n % i === 0) return false;\n  }\n  return true;\n}\n',
      python: 'def is_prime(n: int) -> bool:\n    if n == 2:\n        return True\n    for i in range(2, int(n ** 0.5)):\n        if n % i == 0:\n            return False\n    return True\n',
    },
    examples: [{ args: [7] }, { args: [9], explanation: '9 = 3 × 3.' }, { args: [1], explanation: '1 is not prime.' }],
    tests: [[0], [2], [3], [4], [25], [97], [-7], [1000000007], [999999937], [1000000000], [49]],
    reference: (n: number) => { if (n < 2) return false; for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; },
    timeLimitMs: 800, complexity: 'O(√n) trial division; the bugs are numbers below 2 and a loop that stops before the square root.',
  },
  {
    kind: 'debugging', id: 'debug-most-frequent-word', title: 'Fix: Most Frequent Word', difficulty: 'Intermediate', topics: ['Debugging', 'Strings', 'Hashing'],
    statement: 'This function should return the most frequent word in `text`, ignoring case. Words are runs of the letters a–z; every other character separates words. Return the word in lower case, and break ties by choosing the alphabetically first word. The text contains at least one word.\n\nThe current version has several bugs.',
    constraints: ['1 ≤ text.length ≤ 10^5', 'text contains printable ASCII characters'],
    signature: { name: 'mostFrequentWord', params: [{ name: 'text', type: 'string' }], returns: 'string' },
    languages: ['javascript', 'typescript', 'python'],
    starter: {
      javascript: "function mostFrequentWord(text) {\n  const counts = {};\n  for (const word of text.split(' ')) {\n    counts[word] = (counts[word] || 0) + 1;\n  }\n  let best = '';\n  for (const word in counts) {\n    if (counts[word] > (counts[best] || 0)) best = word;\n  }\n  return best;\n}\n",
      typescript: "function mostFrequentWord(text: string): string {\n  const counts: Record<string, number> = {};\n  for (const word of text.split(' ')) {\n    counts[word] = (counts[word] || 0) + 1;\n  }\n  let best = '';\n  for (const word in counts) {\n    if (counts[word] > (counts[best] || 0)) best = word;\n  }\n  return best;\n}\n",
      python: "def most_frequent_word(text: str) -> str:\n    counts = {}\n    for word in text.split(' '):\n        counts[word] = counts.get(word, 0) + 1\n    return max(counts, key=counts.get)\n",
    },
    examples: [{ args: ['The cat and the hat.'] }, { args: ['b a B a'], explanation: '"a" and "b" both appear twice; "a" comes first.' }],
    tests: [['Hello'], ['one two  two'], ['x,y;x'], ['Zebra apple zebra Apple'], ["It's it's IT"]],
    generate: rng => [[Array.from({ length: 15_000 }, () => word(rng, int(rng, 1, 3), 'abcAB') + [' ', ', ', '; ', '. '][int(rng, 0, 3)]).join('')]],
    reference: (text: string) => {
      const counts = new Map<string, number>();
      for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
      let best = '', bestCount = 0;
      for (const [w, n] of counts) if (n > bestCount || (n === bestCount && w < best)) { best = w; bestCount = n; }
      return best;
    },
    timeLimitMs: 1000, complexity: 'O(n) time: split on non-letters, lower-case, count with a hash map and break ties alphabetically.',
  },
];

const EMPLOYEES = 'CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL, salary INTEGER NOT NULL);';
const STAFF = "INSERT INTO employees VALUES (1, 'Asha', 'Engineering', 72000), (2, 'Ravi', 'Sales', 48000), (3, 'Meera', 'Engineering', 50000), (4, 'Kabir', 'Sales', 61000), (5, 'Ira', 'HR', 72000);";
const SHOP = 'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);\nCREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, amount INTEGER NOT NULL, ordered_on TEXT NOT NULL);';
const CUSTOMERS = "INSERT INTO customers VALUES (1, 'Anil', 'Pune'), (2, 'Bela', 'Delhi'), (3, 'Chetan', 'Pune'), (4, 'Divya', 'Mumbai');";
const ORDERS = "INSERT INTO orders VALUES (1, 1, 250, '2026-01-05'), (2, 3, 120, '2026-01-06'), (3, 1, 90, '2026-02-01');";

const sql: SqlProblem[] = [
  {
    kind: 'sql', id: 'sql-high-earners', title: 'SQL: High Earners', difficulty: 'Beginner', topics: ['SQL', 'Filtering', 'Sorting'],
    statement: 'Return the `name` and `salary` of every employee earning more than 50000, highest salary first. Break ties by name in alphabetical order.',
    constraints: ['Return exactly two columns, in this order: name, salary.'],
    schema: EMPLOYEES, columns: ['name', 'salary'], ordered: true,
    examples: [{ seed: STAFF, expected: [['Asha', 72000], ['Ira', 72000], ['Kabir', 61000]], explanation: 'Meera earns exactly 50000, which is not more than 50000.' }],
    tests: [
      { seed: "INSERT INTO employees VALUES (1, 'Om', 'Ops', 50000), (2, 'Pia', 'Ops', 30000);", expected: [] },
      { seed: "INSERT INTO employees VALUES (1, 'Zoya', 'Ops', 90000), (2, 'Arun', 'Ops', 90000), (3, 'Neel', 'Ops', 50001), (4, 'Bina', 'Ops', 90000);", expected: [['Arun', 90000], ['Bina', 90000], ['Zoya', 90000], ['Neel', 50001]] },
    ],
    reference: 'SELECT name, salary FROM employees WHERE salary > 50000 ORDER BY salary DESC, name ASC;',
    timeLimitMs: 1000, complexity: 'A WHERE filter with ORDER BY salary DESC, name.',
  },
  {
    kind: 'sql', id: 'sql-department-average', title: 'SQL: Department Averages', difficulty: 'Intermediate', topics: ['SQL', 'Aggregation', 'GROUP BY'],
    statement: 'For each department with at least two employees, return `department` and `avg_salary`, the average salary rounded to 2 decimal places. Order by department.',
    constraints: ['Return exactly two columns, in this order: department, avg_salary.'],
    schema: EMPLOYEES, columns: ['department', 'avg_salary'], ordered: true,
    examples: [{ seed: STAFF, expected: [['Engineering', 61000], ['Sales', 54500]], explanation: 'HR has only one employee, so it is left out.' }],
    tests: [
      { seed: "INSERT INTO employees VALUES (1, 'A', 'Ops', 1000), (2, 'B', 'Ops', 1001), (3, 'C', 'Ops', 1001), (4, 'D', 'Legal', 5000);", expected: [['Ops', 1000.67]] },
      { seed: "INSERT INTO employees VALUES (1, 'A', 'Zeta', 10), (2, 'B', 'Zeta', 20), (3, 'C', 'Alpha', 7), (4, 'D', 'Alpha', 8);", expected: [['Alpha', 7.5], ['Zeta', 15]] },
    ],
    reference: 'SELECT department, ROUND(AVG(salary), 2) AS avg_salary FROM employees GROUP BY department HAVING COUNT(*) >= 2 ORDER BY department;',
    timeLimitMs: 1000, complexity: 'GROUP BY department with HAVING COUNT(*) >= 2 and ROUND(AVG(salary), 2).',
  },
  {
    kind: 'sql', id: 'sql-second-highest-salary', title: 'SQL: Second Highest Salary', difficulty: 'Intermediate', topics: ['SQL', 'Subqueries'],
    statement: 'Return one row with one column, `second_highest`: the second highest distinct salary, or NULL if there is no second distinct salary.',
    constraints: ['Always return exactly one row.'],
    schema: EMPLOYEES, columns: ['second_highest'], ordered: true,
    examples: [{ seed: STAFF, expected: [[61000]], explanation: 'The distinct salaries are 72000, 61000, 50000 and 48000.' }],
    tests: [
      { seed: "INSERT INTO employees VALUES (1, 'A', 'Ops', 4000), (2, 'B', 'Ops', 4000);", expected: [[null]] },
      { seed: "INSERT INTO employees VALUES (1, 'A', 'Ops', 4000);", expected: [[null]] },
      { seed: "INSERT INTO employees VALUES (1, 'A', 'Ops', 90000), (2, 'B', 'Ops', 90000), (3, 'C', 'Ops', 80000), (4, 'D', 'Ops', 70000);", expected: [[80000]] },
    ],
    reference: 'SELECT (SELECT DISTINCT salary FROM employees ORDER BY salary DESC LIMIT 1 OFFSET 1) AS second_highest;',
    timeLimitMs: 1000, complexity: 'A scalar subquery over DISTINCT salaries with ORDER BY ... LIMIT 1 OFFSET 1, which yields NULL when there is no second value.',
  },
  {
    kind: 'sql', id: 'sql-customers-without-orders', title: 'SQL: Customers Without Orders', difficulty: 'Beginner', topics: ['SQL', 'Joins'],
    statement: 'Return the `name` of every customer who has never placed an order, in alphabetical order.',
    constraints: ['Return exactly one column: name.'],
    schema: SHOP, columns: ['name'], ordered: true,
    examples: [{ seed: `${CUSTOMERS}\n${ORDERS}`, expected: [['Bela'], ['Divya']] }],
    tests: [
      { seed: `${CUSTOMERS}\nINSERT INTO orders VALUES (1, 1, 5, '2026-01-01'), (2, 2, 5, '2026-01-01'), (3, 3, 5, '2026-01-01'), (4, 4, 5, '2026-01-01');`, expected: [] },
      { seed: CUSTOMERS, expected: [['Anil'], ['Bela'], ['Chetan'], ['Divya']] },
    ],
    reference: 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL ORDER BY c.name;',
    timeLimitMs: 1000, complexity: 'A LEFT JOIN keeping customers whose order side is NULL, or NOT EXISTS.',
  },
  {
    kind: 'sql', id: 'sql-running-total', title: 'SQL: Running Total', difficulty: 'Advanced', topics: ['SQL', 'Window functions'],
    statement: 'For every order, return `id`, `ordered_on`, `amount` and `running_total`: the sum of the amounts of all orders up to and including this one, in order of `ordered_on` and then `id`. Return the rows in that same order.',
    constraints: ['Return exactly four columns, in this order: id, ordered_on, amount, running_total.'],
    schema: SHOP, columns: ['id', 'ordered_on', 'amount', 'running_total'], ordered: true,
    examples: [{ seed: `${CUSTOMERS}\n${ORDERS}`, expected: [[1, '2026-01-05', 250, 250], [2, '2026-01-06', 120, 370], [3, '2026-02-01', 90, 460]] }],
    tests: [
      { seed: "INSERT INTO orders VALUES (5, 1, 10, '2026-03-01'), (2, 1, 20, '2026-03-01'), (9, 2, 5, '2026-02-28');", expected: [[9, '2026-02-28', 5, 5], [2, '2026-03-01', 20, 25], [5, '2026-03-01', 10, 35]] },
      { seed: '', expected: [] },
    ],
    reference: 'SELECT id, ordered_on, amount, SUM(amount) OVER (ORDER BY ordered_on, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total FROM orders ORDER BY ordered_on, id;',
    timeLimitMs: 1000, complexity: 'A window function SUM(amount) OVER (ORDER BY ordered_on, id), or a correlated subquery.',
  },
];

export const PROBLEMS: Problem[] = [...algorithms, ...debugging, ...sql];
export const PROBLEM_BY_ID = new Map(PROBLEMS.map(p => [p.id, p]));
