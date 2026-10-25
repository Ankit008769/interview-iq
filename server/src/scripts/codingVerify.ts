import { randomBytes } from 'node:crypto';
import { PROBLEMS, PROBLEM_BY_ID } from '../coding/problems.js';
import { buildProgram } from '../coding/harness.js';
import { grade } from '../coding/grade.js';
import { runTimeLimit, stdinFor, testCases } from '../coding/tests.js';
import { runOnRunner } from '../coding/runnerClient.js';
import type { CodeLanguage, SubmissionLanguage, Verdict } from '../coding/types.js';

// Operator check of the coding lab against a real runner: every problem's reference solution must be
// accepted (as JavaScript and TypeScript), hand-written solutions must be accepted in every language, broken
// ones must get the right verdict, and debugging starters must still fail. Prints run times per language.
//   RUNNER_URL=http://127.0.0.1:8090 npm run coding:verify [-- --languages javascript,python] [--skip-memory]
const SOLUTIONS: Record<string, Partial<Record<CodeLanguage, string>>> = {
  'two-sum': {
    python: 'def two_sum(nums, target):\n    seen = {}\n    for i, x in enumerate(nums):\n        if target - x in seen:\n            return [seen[target - x], i]\n        seen[x] = i\n',
    java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        Map<Integer, Integer> seen = new HashMap<>();\n        for (int i = 0; i < nums.length; i++) {\n            Integer j = seen.get(target - nums[i]);\n            if (j != null) return new int[] { j, i };\n            seen.put(nums[i], i);\n        }\n        return new int[0];\n    }\n}\n',
    cpp: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        unordered_map<int, int> seen;\n        for (int i = 0; i < (int)nums.size(); i++) {\n            auto it = seen.find(target - nums[i]);\n            if (it != seen.end()) return {it->second, i};\n            seen[nums[i]] = i;\n        }\n        return {};\n    }\n};\n',
  },
  'valid-parentheses': {
    python: "def is_valid(s):\n    pairs = {')': '(', ']': '[', '}': '{'}\n    stack = []\n    for c in s:\n        if c in pairs:\n            if not stack or stack.pop() != pairs[c]:\n                return False\n        else:\n            stack.append(c)\n    return not stack\n",
    java: "class Solution {\n    public boolean isValid(String s) {\n        Deque<Character> stack = new ArrayDeque<>();\n        for (char c : s.toCharArray()) {\n            if (c == '(' || c == '[' || c == '{') stack.push(c);\n            else {\n                if (stack.isEmpty()) return false;\n                char open = stack.pop();\n                if ((c == ')' && open != '(') || (c == ']' && open != '[') || (c == '}' && open != '{')) return false;\n            }\n        }\n        return stack.isEmpty();\n    }\n}\n",
    cpp: "class Solution {\npublic:\n    bool isValid(string& s) {\n        string stack;\n        for (char c : s) {\n            if (c == '(' || c == '[' || c == '{') stack.push_back(c);\n            else {\n                if (stack.empty()) return false;\n                char open = stack.back(); stack.pop_back();\n                if ((c == ')' && open != '(') || (c == ']' && open != '[') || (c == '}' && open != '{')) return false;\n            }\n        }\n        return stack.empty();\n    }\n};\n",
  },
  'merge-intervals': {
    python: 'def merge(intervals):\n    out = []\n    for s, e in sorted(intervals):\n        if out and s <= out[-1][1]:\n            out[-1][1] = max(out[-1][1], e)\n        else:\n            out.append([s, e])\n    return out\n',
    java: 'class Solution {\n    public int[][] merge(int[][] intervals) {\n        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));\n        List<int[]> out = new ArrayList<>();\n        for (int[] i : intervals) {\n            if (!out.isEmpty() && i[0] <= out.get(out.size() - 1)[1]) out.get(out.size() - 1)[1] = Math.max(out.get(out.size() - 1)[1], i[1]);\n            else out.add(new int[] { i[0], i[1] });\n        }\n        return out.toArray(new int[0][]);\n    }\n}\n',
    cpp: 'class Solution {\npublic:\n    vector<vector<int>> merge(vector<vector<int>>& intervals) {\n        sort(intervals.begin(), intervals.end());\n        vector<vector<int>> out;\n        for (auto& i : intervals) {\n            if (!out.empty() && i[0] <= out.back()[1]) out.back()[1] = max(out.back()[1], i[1]);\n            else out.push_back(i);\n        }\n        return out;\n    }\n};\n',
  },
  'group-anagrams': {
    python: "def group_anagrams(strs):\n    groups = {}\n    for s in strs:\n        groups.setdefault(''.join(sorted(s)), []).append(s)\n    return list(groups.values())\n",
    java: 'class Solution {\n    public List<List<String>> groupAnagrams(String[] strs) {\n        Map<String, List<String>> groups = new LinkedHashMap<>();\n        for (String s : strs) {\n            char[] c = s.toCharArray(); Arrays.sort(c);\n            groups.computeIfAbsent(new String(c), k -> new ArrayList<>()).add(s);\n        }\n        return new ArrayList<>(groups.values());\n    }\n}\n',
    cpp: 'class Solution {\npublic:\n    vector<vector<string>> groupAnagrams(vector<string>& strs) {\n        unordered_map<string, vector<string>> groups;\n        for (auto& s : strs) { string k = s; sort(k.begin(), k.end()); groups[k].push_back(s); }\n        vector<vector<string>> out;\n        for (auto& g : groups) out.push_back(g.second);\n        return out;\n    }\n};\n',
  },
  'climbing-stairs': {
    python: 'def climb_stairs(n):\n    a, b = 1, 1\n    for _ in range(n - 1):\n        a, b = b, a + b\n    return b\n',
    java: 'class Solution {\n    public long climbStairs(int n) {\n        long a = 1, b = 1;\n        for (int i = 2; i <= n; i++) { long c = a + b; a = b; b = c; }\n        return b;\n    }\n}\n',
    cpp: 'class Solution {\npublic:\n    long long climbStairs(int n) {\n        long long a = 1, b = 1;\n        for (int i = 2; i <= n; i++) { long long c = a + b; a = b; b = c; }\n        return b;\n    }\n};\n',
  },
  'trapping-rain-water': {
    python: 'def trap(height):\n    i, j = 0, len(height) - 1\n    left = right = water = 0\n    while i < j:\n        if height[i] < height[j]:\n            left = max(left, height[i]); water += left - height[i]; i += 1\n        else:\n            right = max(right, height[j]); water += right - height[j]; j -= 1\n    return water\n',
    java: 'class Solution {\n    public long trap(int[] height) {\n        int i = 0, j = height.length - 1; long left = 0, right = 0, water = 0;\n        while (i < j) {\n            if (height[i] < height[j]) { left = Math.max(left, height[i]); water += left - height[i]; i++; }\n            else { right = Math.max(right, height[j]); water += right - height[j]; j--; }\n        }\n        return water;\n    }\n}\n',
    cpp: 'class Solution {\npublic:\n    long long trap(vector<int>& height) {\n        int i = 0, j = (int)height.size() - 1; long long left = 0, right = 0, water = 0;\n        while (i < j) {\n            if (height[i] < height[j]) { left = max(left, (long long)height[i]); water += left - height[i]; i++; }\n            else { right = max(right, (long long)height[j]); water += right - height[j]; j--; }\n        }\n        return water;\n    }\n};\n',
  },
  'number-of-islands': {
    python: "from collections import deque\n\ndef num_islands(grid):\n    rows, cols = len(grid), len(grid[0])\n    seen = [[False] * cols for _ in range(rows)]\n    count = 0\n    for r in range(rows):\n        for c in range(cols):\n            if grid[r][c] != '1' or seen[r][c]:\n                continue\n            count += 1\n            seen[r][c] = True\n            queue = deque([(r, c)])\n            while queue:\n                y, x = queue.popleft()\n                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):\n                    if 0 <= ny < rows and 0 <= nx < cols and not seen[ny][nx] and grid[ny][nx] == '1':\n                        seen[ny][nx] = True\n                        queue.append((ny, nx))\n    return count\n",
    java: "class Solution {\n    public int numIslands(String[] grid) {\n        int rows = grid.length, cols = grid[0].length(), count = 0;\n        boolean[] seen = new boolean[rows * cols];\n        int[] queue = new int[rows * cols];\n        for (int start = 0; start < rows * cols; start++) {\n            if (seen[start] || grid[start / cols].charAt(start % cols) != '1') continue;\n            count++; seen[start] = true; int head = 0, tail = 0; queue[tail++] = start;\n            while (head < tail) {\n                int cell = queue[head++], r = cell / cols, c = cell % cols;\n                int[][] next = { { r + 1, c }, { r - 1, c }, { r, c + 1 }, { r, c - 1 } };\n                for (int[] n : next) {\n                    if (n[0] < 0 || n[1] < 0 || n[0] >= rows || n[1] >= cols) continue;\n                    int k = n[0] * cols + n[1];\n                    if (!seen[k] && grid[n[0]].charAt(n[1]) == '1') { seen[k] = true; queue[tail++] = k; }\n                }\n            }\n        }\n        return count;\n    }\n}\n",
    cpp: "class Solution {\npublic:\n    int numIslands(vector<string>& grid) {\n        int rows = grid.size(), cols = grid[0].size(), count = 0;\n        vector<char> seen(rows * cols, 0);\n        for (int start = 0; start < rows * cols; start++) {\n            if (seen[start] || grid[start / cols][start % cols] != '1') continue;\n            count++; seen[start] = 1; queue<int> q; q.push(start);\n            while (!q.empty()) {\n                int cell = q.front(); q.pop(); int r = cell / cols, c = cell % cols;\n                int dr[] = {1, -1, 0, 0}, dc[] = {0, 0, 1, -1};\n                for (int d = 0; d < 4; d++) {\n                    int nr = r + dr[d], nc = c + dc[d];\n                    if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;\n                    int k = nr * cols + nc;\n                    if (!seen[k] && grid[nr][nc] == '1') { seen[k] = 1; q.push(k); }\n                }\n            }\n        }\n        return count;\n    }\n};\n",
  },
  'maximum-subarray': {
    python: 'def max_sub_array(nums):\n    best, current = nums[0], 0\n    for x in nums:\n        current = max(x, current + x)\n        best = max(best, current)\n    return best\n',
    java: 'class Solution {\n    public int maxSubArray(int[] nums) {\n        int best = nums[0], current = 0;\n        for (int x : nums) { current = Math.max(x, current + x); best = Math.max(best, current); }\n        return best;\n    }\n}\n',
    cpp: 'class Solution {\npublic:\n    int maxSubArray(vector<int>& nums) {\n        int best = nums[0], current = 0;\n        for (int x : nums) { current = max(x, current + x); best = max(best, current); }\n        return best;\n    }\n};\n',
  },
  'debug-average': { python: 'def average(nums):\n    return sum(nums) / len(nums) if nums else 0.0\n' },
};

// Broken submissions and the verdict each must receive.
const BROKEN: { problem: string; language: SubmissionLanguage; source: string; verdict: Verdict; memory?: boolean }[] = [
  { problem: 'two-sum', language: 'python', source: 'def two_sum(nums, target):\n    return [0, 0]\n', verdict: 'wrong_answer' },
  { problem: 'longest-increasing-subsequence', language: 'python', verdict: 'time_limit',
    source: 'def length_of_lis(nums):\n    best = [1] * len(nums)\n    for i in range(len(nums)):\n        for j in range(i):\n            if nums[j] < nums[i] and best[j] + 1 > best[i]:\n                best[i] = best[j] + 1\n    return max(best)\n' },
  { problem: 'valid-parentheses', language: 'python', source: "def is_valid(s):\n    raise ValueError('boom')\n", verdict: 'runtime_error' },
  { problem: 'valid-parentheses', language: 'javascript', source: 'function isValid(s) {\n  while (true) {}\n}\n', verdict: 'time_limit' },
  { problem: 'valid-parentheses', language: 'java', source: 'class Solution {\n    public boolean isValid(String s) { return true }\n}\n', verdict: 'compile_error' },
  { problem: 'valid-parentheses', language: 'cpp', source: 'class Solution {\npublic:\n    bool isValid(string& s) { return true }\n};\n', verdict: 'compile_error' },
  { problem: 'valid-parentheses', language: 'python', source: 'def is_valid(s):\n    block = [0] * (10 ** 9)\n    return True\n', verdict: 'runtime_error', memory: true },
  { problem: 'sql-high-earners', language: 'sql', source: 'SELECT name, salary FROM employees ORDER BY salary DESC;', verdict: 'wrong_answer' },
  { problem: 'sql-high-earners', language: 'sql', source: 'SELEC name FROM employees;', verdict: 'runtime_error' },
];

const args = process.argv.slice(2);
const only = args.includes('--languages') ? new Set(args[args.indexOf('--languages') + 1].split(',')) : null;
const allowed = (language: SubmissionLanguage) => !only || only.has(language === 'sql' ? 'python' : language);
const times: Record<string, number[]> = {};
let failures = 0, checks = 0;

async function check(label: string, problemId: string, language: SubmissionLanguage, source: string, expected: Verdict, expectFail = false) {
  if (!allowed(language)) return;
  const problem = PROBLEM_BY_ID.get(problemId)!;
  const tests = testCases(problem, 'submit');
  const nonce = randomBytes(9).toString('hex');
  const program = buildProgram(problem, language, source, nonce);
  const started = performance.now();
  const response = await runOnRunner({ ...program, stdin: stdinFor(tests), timeLimitMs: runTimeLimit(problem, language, 'submit') });
  const elapsed = performance.now() - started;
  const graded = grade(problem, language, source.split('\n').length, tests, nonce, response);
  checks++;
  const ok = expectFail ? graded.verdict !== 'accepted' : graded.verdict === expected;
  if (!ok) failures++;
  if (!expectFail && expected === 'accepted') (times[language] ??= []).push(elapsed);
  const detail = ok ? '' : ` -> got ${graded.verdict} (${graded.passed}/${graded.total}) ${(graded.message ?? graded.output).slice(0, 300).replace(/\s+/g, ' ')}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} [${language}] ${Math.round(elapsed)} ms${detail}`);
}

for (const problem of PROBLEMS) {
  if (problem.kind === 'sql') { await check(`${problem.id} reference`, problem.id, 'sql', problem.reference, 'accepted'); continue; }
  const name = problem.signature.name;
  // tsx keeps function names with a __name helper; the shim lets the reference run on its own.
  const reference = `const __name = (f) => f;\nconst ${name} = ${problem.reference.toString()};\n`;
  await check(`${problem.id} reference`, problem.id, 'javascript', reference, 'accepted');
  await check(`${problem.id} reference`, problem.id, 'typescript', reference, 'accepted');
  for (const [language, source] of Object.entries(SOLUTIONS[problem.id] ?? {})) await check(`${problem.id} solution`, problem.id, language as CodeLanguage, source!, 'accepted');
  if (problem.kind === 'debugging') for (const [language, source] of Object.entries(problem.starter ?? {})) await check(`${problem.id} buggy starter`, problem.id, language as CodeLanguage, source!, 'accepted', true);
}
for (const broken of BROKEN) {
  if (broken.memory && args.includes('--skip-memory')) continue;
  await check(`${broken.problem} broken (${broken.verdict})`, broken.problem, broken.language, broken.source, broken.verdict);
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)];
for (const [language, values] of Object.entries(times)) {
  console.log(`time ${language}: n=${values.length} p50=${Math.round(percentile(values, 50))} ms p95=${Math.round(percentile(values, 95))} ms max=${Math.round(Math.max(...values))} ms`);
}
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
