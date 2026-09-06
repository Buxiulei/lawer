// 轻量 OpenAPI 3.1 结构校验器（判据用；仓库里没有 ajv / swagger-parser 这类依赖，
// 为一份自家生成的文档引一整套 schema 校验不划算）。
//
// 它只查**导入方真的会因此失败**的那些结构：版本号、servers 是绝对地址、
// 每个 operation 有 operationId 与 responses、参数四件套齐、$ref 指得到、
// securityScheme 声明过。查不到的（比如 description 写得好不好）不在这里假装能查。
//
// 【为什么回一串问题而不是抛第一个】一次跑完能看见全部结构问题；抛第一个的形态是
// 修一条、再跑、再修一条，而每轮只知道一条。
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 顺着 `#/a/b/c` 走一遍，走不到就是断链 */
function resolveRef(root: Record<string, unknown>, ref: string): boolean {
  if (!ref.startsWith('#/')) return false;
  let node: unknown = root;
  for (const seg of ref.slice(2).split('/')) {
    if (!isObject(node)) return false;
    node = node[seg];
  }
  return node !== undefined;
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

/** 回一串人话问题；空数组 = 通过 */
export function validateOpenApi(doc: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(doc)) return ['文档不是对象'];

  if (typeof doc.openapi !== 'string' || !/^3\.1\.\d+$/.test(doc.openapi)) {
    problems.push(`openapi 必须是 3.1.x，现在是 ${String(doc.openapi)}`);
  }

  const info = doc.info;
  if (!isObject(info)) problems.push('缺 info');
  else {
    if (typeof info.title !== 'string' || !info.title) problems.push('info.title 为空');
    if (typeof info.version !== 'string' || !info.version) problems.push('info.version 为空');
  }

  const servers = doc.servers;
  if (!Array.isArray(servers) || servers.length === 0) problems.push('缺 servers');
  else {
    for (const s of servers) {
      const url = isObject(s) ? s.url : undefined;
      if (typeof url !== 'string' || !/^https?:\/\/[^/]+/.test(url)) {
        problems.push(`servers[].url 不是绝对地址：${String(url)}`);
      }
    }
  }

  const schemes = isObject(doc.components) ? doc.components.securitySchemes : undefined;
  const schemeNames = isObject(schemes) ? Object.keys(schemes) : [];
  if (schemeNames.length === 0) problems.push('缺 components.securitySchemes');

  const paths = doc.paths;
  if (!isObject(paths) || Object.keys(paths).length === 0) {
    problems.push('paths 为空');
    return problems;
  }

  const seen = new Map<string, string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/')) problems.push(`路径必须以 / 开头：${path}`);
    if (!isObject(item)) {
      problems.push(`${path} 的值不是对象`);
      continue;
    }
    const declared = new Set(
      [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]),
    );
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) {
        problems.push(`${path} 上有非法方法 ${method}`);
        continue;
      }
      if (!isObject(op)) {
        problems.push(`${method.toUpperCase()} ${path} 不是对象`);
        continue;
      }
      const id = op.operationId;
      if (typeof id !== 'string' || !id) {
        problems.push(`${method.toUpperCase()} ${path} 缺 operationId`);
      } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) {
        problems.push(`operationId 只能是字母数字下划线：${id}`);
      } else if (seen.has(id)) {
        problems.push(`operationId 重复：${id}（${seen.get(id)} 与 ${method.toUpperCase()} ${path}）`);
      } else {
        seen.set(id, `${method.toUpperCase()} ${path}`);
      }

      if (!isObject(op.responses) || Object.keys(op.responses).length === 0) {
        problems.push(`${method.toUpperCase()} ${path} 缺 responses`);
      }

      const params = op.parameters ?? [];
      if (!Array.isArray(params)) {
        problems.push(`${method.toUpperCase()} ${path} 的 parameters 不是数组`);
        continue;
      }
      const inPath = new Set<string>();
      for (const p of params) {
        if (!isObject(p)) {
          problems.push(`${method.toUpperCase()} ${path} 有非对象参数`);
          continue;
        }
        if (typeof p.name !== 'string' || !p.name) problems.push(`${path} 有无名参数`);
        if (!['path', 'query', 'header', 'cookie'].includes(String(p.in))) {
          problems.push(`${path} 参数 ${String(p.name)} 的 in 非法：${String(p.in)}`);
        }
        if (!isObject(p.schema)) problems.push(`${path} 参数 ${String(p.name)} 缺 schema`);
        if (p.in === 'path') {
          inPath.add(String(p.name));
          // 规范硬要求：path 参数必须 required: true
          if (p.required !== true) problems.push(`${path} 的路径参数 ${String(p.name)} 必须 required`);
        }
      }
      for (const name of declared) {
        if (!inPath.has(name)) {
          problems.push(`${method.toUpperCase()} ${path} 的路径段 {${name}} 没有对应的参数声明`);
        }
      }
      for (const name of inPath) {
        if (!declared.has(name)) {
          problems.push(`${method.toUpperCase()} ${path} 声明了路径里没有的参数 ${name}`);
        }
      }

      for (const s of Array.isArray(op.security) ? op.security : []) {
        for (const name of isObject(s) ? Object.keys(s) : []) {
          if (!schemeNames.includes(name)) {
            problems.push(`${method.toUpperCase()} ${path} 引用了未声明的 security scheme ${name}`);
          }
        }
      }
    }
  }

  for (const ref of collectRefs(doc)) {
    if (!resolveRef(doc, ref)) problems.push(`$ref 指不到：${ref}`);
  }

  return problems;
}
