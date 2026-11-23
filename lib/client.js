/**
 * 学理模式 · 浏览器半（手写 ModuleLoader bundle，无构建步骤）
 *
 * 一个座位：设置页左侧导航里的「中医 · 经方（学习版）」一节。
 * 里面只有一项设置：资料库目录。
 * 改完保存，下一句话就按新目录找书，不用重启。
 */
window.__ModuleLoader__.load({
  // 登记名必须等于 package.json 的 name（dsh-tcm-xueli）。宿主按包名把浏览器半侧挂进模块表，
  // 写成目录名 dsh-tcm-xueli 时这份半侧永远等不到导入，设置导航里的「中医 · 经方」整节都不会出现。
  id: 'dsh-tcm-xueli',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var ui = require('@deepseek-ai/dsh-client-ui-primitives');

    var E = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    /** 与本插件行 id 一致，也就是 configForms 的命名空间。 */
    var NS = 'dsh-tcm-xueli';
    var TAG = '[dsh-tcm-xueli]';

    var DEFAULT_NOTE = '不设默认目录：请自己填一个资料库目录。这一项没填之前，插件不建索引、不归档医案、不补随包经典。中医会话查书、生成索引、归档医案都放在你填的这个目录里。';
    // 资料库文件夹叫什么由用户定，不再卡死名字：只校验是不是完整路径。
    // 学习版与完整版各填各的目录，插件只读自己这一份配置，不会串库。
    var PATH_HINT = '写完整路径就行，文件夹叫什么都可以，例如 D:/中医工作区/中医经方学习版资料库';


    /** 完整路径：Windows 盘符、UNC 共享（\\\\server\\share），或 POSIX 的 / 、~ 开头。 */
    var FULL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/(?!\/)|~[\\/]|~$)/;

    var muted = {
      margin: 0,
      fontSize: 16,
      lineHeight: 1.8,
      color: 'var(--dsw-alias-text-secondary, #666)',
    };

    /** 订阅一份设置表单，拿到当前快照。读快照、订阅都可能同步抛错：包起来优雅降级。 */
    function useSnapshot(form) {
      var pair = useState(function () {
        try {
          return form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null;
        } catch (error) {
          return null;
        }
      });
      var snapshot = pair[0];
      var setSnapshot = pair[1];

      useEffect(function () {
        if (!form || typeof form.subscribe !== 'function') return undefined;
        var sync = function () {
          try {
            setSnapshot(form.getSnapshot());
          } catch (error) { /* 读不到就保持上一份快照 */ }
        };
        sync();
        try {
          return form.subscribe(sync);
        } catch (error) {
          return undefined;
        }
      }, [form]);

      return snapshot;
    }

    function noteNode(note) {
      if (note === null) return null;
      var color = note.kind === 'ok'
        ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
        : note.kind === 'warn'
          ? 'var(--dsw-alias-state-warning-primary, #a15c00)'
          : 'var(--dsw-alias-state-error-primary, #c62828)';
      return E('p', { style: { margin: 0, fontSize: 16, lineHeight: 1.8, color: color } }, note.text);
    }

    /** 组件渲染时再取一次表单：configForms 晚到也能接上。 */
    function resolveForm(props) {
      if (props.form) return props.form;
      try {
        var ctx = props.ctx;
        if (!ctx || typeof ctx.get !== 'function') return null;
        var forms = ctx.get('configForms');
        if (!forms || typeof forms.get !== 'function') return null;
        return forms.get(NS);
      } catch (error) {
        return null;
      }
    }

    function Card(props) {
      var form = resolveForm(props);

      // hooks 必须无条件先调：form 晚到、或某次重渲染才拿到 form 时，
      // 提前 return 会让两次渲染的 hook 数量不同，React 直接抛
      // 「Rendered more hooks than during the previous render」，整个设置节跟着报错。
      var snapshot = useSnapshot(form);
      var status = snapshot === null ? 'loading' : snapshot.status;
      var saved = status === 'ready' && snapshot.value && typeof snapshot.value.kbPath === 'string'
        ? snapshot.value.kbPath
        : '';

      var draftPair = useState(saved);
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var dirtyPair = useState(false);
      var dirty = dirtyPair[0];
      var setDirty = dirtyPair[1];
      var notePair = useState(null);
      var note = notePair[0];
      var setNote = notePair[1];
      var busyPair = useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      useEffect(function () {
        if (!dirty) setDraft(saved);
      }, [saved, dirty]);

      // 全部 hook 之后才允许早退：设置服务晚到时也保持同样的 hook 顺序。
      if (!form) {
        return E('div', { style: { maxWidth: 720 } },
          E('h2', { style: { margin: '0 0 6px', fontSize: 20, fontWeight: 600 } }, '中医 · 经方（学习版）｜资料库目录'),
          E('p', { style: muted }, '设置服务还没准备好，稍等片刻或重启 DSH 后再试。'));
      }

      var save = function () {
        if (busy) return;
        var text = String(draft).trim();
        if (text !== '' && !FULL_PATH.test(text)) {
          setNote({ kind: 'err', text: '请填写完整路径，' + PATH_HINT });
          return;
        }
        setBusy(true);
        setNote(null);
        var write;
        try {
          write = text === '' ? form.unset('kbPath') : form.set('kbPath', text);
        } catch (error) {
          setBusy(false);
          setNote({ kind: 'err', text: '保存失败：' + (error && error.message ? error.message : String(error)) });
          return;
        }
        Promise.resolve(write).then(function (accepted) {
          if (accepted === false) {
            setNote({ kind: 'err', text: '保存失败：设置没有接受这个路径，请确认写的是完整路径后重试。' });
            return;
          }
          setDirty(false);
          setNote({
            kind: 'ok',
            text: text === '' ? '已清空：清空后插件不建索引、不归档，也不会再引书讲方。' : '已保存，下一句话就按新目录找书。',
          });
        }, function (error) {
          setNote({
            kind: 'err',
            text: '保存失败：' + (error && error.message ? error.message : String(error)),
          });
        }).then(function () {
          setBusy(false);
        });
      };

      if (status === 'unavailable') {
        return E('div', { style: { maxWidth: 720 } },
          E('h2', { style: { margin: '0 0 6px', fontSize: 20, fontWeight: 600 } }, '中医 · 经方（学习版）｜资料库目录'),
          E('p', { style: muted }, '这个设置项当前不可用：中医预设插件没有加载成功。'));
      }

      return E('div', { style: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 14 } },
        E('div', null,
          E('h2', { style: { margin: '0 0 6px', fontSize: 20, fontWeight: 600 } }, '中医 · 经方（学习版）｜资料库目录'),
          E('p', { style: muted },
            '本插件与「中医 · 经方（学习版）」预设配套，仅供学习研究使用：只讲辨证思路，不给具体剂量，不出处方笺；针灸只给推荐穴位。它是学习版，与另一个「中医 · 经方（完整版）」是两个插件，资料库各填各的，别混用。'),
          E('p', { style: muted }, DEFAULT_NOTE)),
        // 首次启用、还没填路径时，卡片最上方单独一条醒目提示，别让人错过。
        status === 'ready' && saved === ''
          ? E('div', {
            role: 'note',
            style: {
              padding: '12px 14px',
              borderRadius: 10,
              border: '1px solid #e0b34d',
              background: '#fff8e6',
              color: '#6b4c00',
              lineHeight: 1.8,
              fontSize: 15,
            },
          },
          E('strong', null, '先填资料库目录，插件才会工作。'),
          E('div', null,
            '第一次用还没有设定资料库：在上面这个框里填一个你自己的目录，点保存。'
              + '哪个盘都行，新建一个空文件夹填进去就可以，不必是某个固定的盘。'
              + '没填之前，它不建索引、不归档医案、不补随包经典，回答也只会给治法方向，不引书、不报方名。'))
          : null,
        E('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          E('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            E(ui.Input, {
              value: draft,
              placeholder: PATH_HINT,
              spellCheck: false,
              autoComplete: 'off',
              style: { width: '100%', boxSizing: 'border-box' },
              onChange: function (event) {
                setDirty(true);
                setNote(null);
                setDraft(event.target.value);
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  save();
                }
              },
            })),
          E(ui.Button, {
            variant: 'primary',
            size: 'md',
            disabled: busy || !dirty,
            onClick: save,
          }, busy ? '保存中…' : '保存')),
        E('p', { style: muted },
          '当前生效：' + (saved === '' ? '未设置' : saved) + '　清空后保存即停止使用资料库。'),
        E('p', { style: muted },
          '索引.md 由插件按上面的目录自动生成：DSH 启动时建一次，书目增删后自动更新；'
            + '同一目录只会挂一份目录监视，重复加载也不会重复写。'),
        E('p', { style: muted },
          '有问题、想提意见，写邮件给作者：15020677063@163.com'),
        noteNode(note));
    }

    var register = function (ctx, form) {
      try {
        var injected = function () {
          return { form: form, ctx: ctx };
        };
        if (ctx.slots && typeof ctx.slots.register === 'function') {
          return ctx.slots.register({
            name: 'settings.section',
            id: NS,
            order: 60,
            label: '中医 · 经方（学习版）',
            inject: injected,
          }, Card);
        }
      } catch (error) {
        console.warn(TAG + ' 设置卡片注册失败：', error && error.message ? error.message : error);
      }
      return undefined;
    };

    // ── 左侧「经方学习版」入口 + 工作台（左列历史会话，右列当前会话）──────────
    //
    // 点左侧的「学」图标，主区域换成学习版工作台：左列是本预设（dsh-tcm-xueli）
    // 的历史会话，右列是当前这一局的聊天，「新建会话」就在右列开一局。
    // 聊天区装配官方会话视图（conversation.content），跟正常聊天页一样有输入框。

    var Ctx = null;
    var WB_PANEL = 'xueli-wb';
    var WB_PRESET = 'dsh-tcm-xueli';
    var WB_LOG = '[学习版工作台] ';
    var WB_TITLE = '经方学习版工作台';
    var WB_CHAT_SLOT = 'xueli.wb.chat';

    function wbReason(error) {
      return String(error && error.message ? error.message : error);
    }

    function wbCss() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('xw-style')) return;
      var style = document.createElement('style');
      style.id = 'xw-style';
      style.setAttribute('data-plugin', NS);
      style.textContent = [
        '.xw-wrap{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px}',
        '.xw-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.18);flex:none}',
        '.xw-brand{font-weight:600;font-size:13px;margin-right:auto}',
        '.xw-btn{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;line-height:18px}',
        '.xw-btn:hover{background:rgba(127,127,127,.12)}',
        '.xw-btn.pri{background:#3b6ef5;border-color:#3b6ef5;color:#fff}',
        '.xw-btn.pri:hover{background:#2f5ed8}',
        '.xw-btn:disabled{opacity:.55;cursor:default}',
        '.xw-body{display:flex;flex:1;min-height:0}',
        '.xw-side{width:268px;flex:none;border-right:1px solid rgba(127,127,127,.18);display:flex;flex-direction:column;min-height:0}',
        '.xw-search{margin:6px;padding:5px 8px;font-size:12px;border:1px solid rgba(127,127,127,.3);border-radius:6px;background:transparent;color:inherit;outline:none;flex:none}',
        '.xw-now{display:flex;align-items:center;gap:6px;padding:0 10px 6px;font-size:11.5px;opacity:.7;flex:none}',
        '.xw-now .dot{width:6px;height:6px;border-radius:50%;background:#3b6ef5;flex:none}',
        '.xw-now .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.xw-items{flex:1;min-height:0;overflow-y:auto;padding:0 6px 6px}',
        '.xw-item{position:relative;padding:7px 9px;border-radius:8px;cursor:pointer;margin-bottom:2px}',
        '.xw-ops{display:none;gap:4px;margin-top:4px}',
        '.xw-item:hover .xw-ops,.xw-item.on .xw-ops{display:flex}',
        '.xw-mini{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:5px;padding:1px 7px;font-size:11px;cursor:pointer;line-height:16px}',
        '.xw-mini:hover{background:rgba(127,127,127,.14)}',
        '.xw-mini.danger{color:#d9534f;border-color:rgba(217,83,79,.5)}',
        '.xw-inline{width:100%;padding:4px 6px;font-size:12px;border:1px solid rgba(127,127,127,.4);border-radius:5px;background:transparent;color:inherit;outline:none}',
        '.xw-item{padding:7px 9px;border-radius:8px;cursor:pointer;margin-bottom:2px}',
        '.xw-item:hover{background:rgba(127,127,127,.12)}',
        '.xw-item.on{background:rgba(59,110,245,.14)}',
        '.xw-item .t{font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.xw-item .m{font-size:11px;opacity:.55;line-height:16px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.xw-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}',
        '.xw-chat{flex:1 1 auto;height:calc(100vh - 168px);min-height:360px;display:flex;flex-direction:column;overflow:hidden}',
        '.xw-chat>*{flex:1 1 auto;min-height:0}',
        '.xw-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center}',
        '.xw-empty .big{font-size:15px;font-weight:600}',
        '.xw-hint{font-size:12px;opacity:.62;line-height:18px}',
        '.xw-err{color:#d9534f}',
        '.xw-arch{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#fff7e6;border-bottom:1px solid #f0d9a8;color:#8a6100;font-size:12px}',
        '.xw-tag{margin-left:6px;padding:0 5px;border-radius:3px;background:#eee;color:#888;font-size:11px}',
        '.xw-btn.on{background:#e8f0ff;border-color:#9bb8f2;color:#2a5bb8}'
        + '.xw-arch>span{flex:1}'
        + '.xw-main{position:relative}'
        + '.xw-welcome{position:absolute;left:0;right:0;top:0;bottom:108px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;pointer-events:none;padding:0 26px}'
        + '.xw-welcome .big{font-size:22px;font-weight:600;letter-spacing:1px;margin-bottom:10px}'
        + '.xw-welcome .line{font-size:14.5px;line-height:2;opacity:.88}'
        + '.xw-welcome .rule{margin-top:14px;font-size:12.5px;line-height:1.9;opacity:.55}',
        // ── 医案（只读导入）──
        // 左列医案区小标题
        '.xw-ysec{margin:10px 4px 3px;font-size:11px;font-weight:600;opacity:.6}',
        // 医案选择器：覆盖层＋弹层
        '.xw-mask{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:60}',
        '.xw-picker{width:440px;max-width:92vw;max-height:72vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-primary,#fff);border:1px solid rgba(127,127,127,.28);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18)}',
        '.xw-picker-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.18);font-weight:600;flex:none}',
        '.xw-picker-head .grow{flex:1}',
        '.xw-picker-list{flex:1;min-height:0;overflow-y:auto;padding:6px}',
        '.xw-picker-row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px}',
        '.xw-picker-row:hover{background:rgba(127,127,127,.1)}',
        '.xw-picker-row .t{flex:1;min-width:0;font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.xw-picker-row .m{flex:none;font-size:11px;opacity:.55}',
        '.xw-picker-note{padding:16px 12px;font-size:12px;line-height:18px;opacity:.75;text-align:center}',
        '.xw-picker-note.xw-err{opacity:1}',
        // 右栏只读医案查看器：头部一条＋滚动正文
        '.xw-yian{flex:1;min-height:0;display:flex;flex-direction:column}',
        '.xw-yian-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.18);flex:none}',
        '.xw-yian-head .t{font-weight:600;font-size:13px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.xw-yian-head .m{flex:1;min-width:0;font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.xw-yian-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;font-size:13px;line-height:1.8}',
      ].join('');
      document.head.appendChild(style);
    }

    // 拿客户端服务：有的内核把注入的服务挂成属性，有的只认 ctx.get(name)，两条都试。
    function svcOf(name) {
      try {
        if (!Ctx) return undefined;
        if (typeof Ctx.get === 'function') {
          var got = Ctx.get(name);
          if (got) return got;
        }
        return Ctx[name];
      } catch (error) {
        return undefined;
      }
    }

    function wbSessions() {
      return svcOf('sessions');
    }

    // 官方接口偶尔不回调：给个上限，别让按钮一直转圈。
    function wbTimeout(promise, ms, label) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error(label + '超时（' + Math.round(ms / 1000) + ' 秒没回话）')); }, ms);
        Promise.resolve(promise).then(
          function (value) { clearTimeout(timer); resolve(value); },
          function (error) { clearTimeout(timer); reject(error); });
      });
    }

    function wbTime(ms) {
      var t = Number(ms) || 0;
      if (!t) return '';
      try {
        var d = new Date(t);
        var now = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
      } catch (error) {
        return '';
      }
    }

    // ── 医案（只读导入）工具函数 ─────────────────────────────────────────────
    // 「已导入医案」清单持久化：localStorage 存 [{file,title,at}]，按 file 去重、
    // 新的在前、最多留 200 条。写法照 loadShownIds/persistShownIds：非浏览器环境静默跳过。
    var YIAN_KEY = NS + ':yian';
    var YIAN_KEEP = 200;

    /** 一条清单记录合不合格：file 必须是非空字符串，标题缺了就认文件名。 */
    function yianEntry(it) {
      if (!it || typeof it.file !== 'string' || !it.file) return null;
      return { file: it.file, title: String(it.title || it.file), at: Number(it.at) || 0 };
    }

    function loadYianList() {
      var out = [];
      try {
        if (typeof localStorage === 'undefined') return out;
        var raw = localStorage.getItem(YIAN_KEY);
        if (!raw) return out;
        var arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return out;
        var seen = {};
        for (var i = 0; i < arr.length && out.length < YIAN_KEEP; i += 1) {
          var one = yianEntry(arr[i]);
          if (!one || seen[one.file]) continue;
          seen[one.file] = true;
          out.push(one);
        }
      } catch (error) { /* 读不到/读坏了就当空，不影响主体 */ }
      return out;
    }

    function persistYianList(list) {
      try {
        if (typeof localStorage === 'undefined') return;
        var arr = Array.isArray(list) ? list : [];
        localStorage.setItem(YIAN_KEY, JSON.stringify(arr.slice(0, YIAN_KEEP)));
      } catch (error) { /* 写不进就算了：清单只是缓存，内存里这份仍然有效 */ }
    }

    /** 纯函数：把一条医案记到清单最前，按 file 去重（重复的以这次为准），最多 200 条。 */
    function yianAddToList(list, entry) {
      var out = [];
      var seen = {};
      var push = function (it) {
        var one = yianEntry(it);
        if (!one || seen[one.file]) return;
        seen[one.file] = true;
        out.push(one);
      };
      push(entry);
      var old = Array.isArray(list) ? list : [];
      for (var i = 0; i < old.length; i += 1) push(old[i]);
      return out.slice(0, YIAN_KEEP);
    }

    /** 医案通道 GET：credentials 照 doDelete 的写法；fetch 同步抛错也接成拒绝。 */
    function yianGet(url) {
      return Promise.resolve().then(function () {
        return fetch(url, { credentials: 'same-origin' });
      }).then(function (res) {
        if (!res || typeof res.json !== 'function') throw new Error('通道没应声');
        return res.json().then(function (got) {
          // HTTP 非 2xx 且没给业务 reason 时才按状态码报错；给了 reason 交给调用方显示。
          if (res.ok === false && (!got || got.ok !== false)) throw new Error('通道报错（HTTP ' + res.status + '）');
          return got;
        });
      });
    }

    function WbChatOnly(props) {
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    function WbChatSlot(props) {
      // 这层 try/catch 只接得住创建元素这一步的同步抛错；渲染期错误由宿主条目边界兜底。
      try {
        return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active' }, {
          slots: { views: WbChatOnly },
        });
      } catch (error) {
        console.warn(WB_LOG + '聊天区没画出来：', wbReason(error));
        return E('div', { className: 'xw-hint xw-err' }, '聊天区没画出来：' + wbReason(error));
      }
    }

    /** 右列：先跟宿主绑定这一局会话，再用 SessionProvider 圈定，然后画插槽。 */
    function WbChatPane(props) {
      // 绑定的那一局连同 id 一起存成状态：换局时绝不会把上一局已经释放的
      // 句柄交给会话组件（那正是「Session reference is released」报错的来源）。
      var holdState = useState(null);
      var hold = holdState[0];
      var setHold = holdState[1];
      var tick = useState(0);
      var force = tick[1];
      var sessionId = props.sessionId;
      // 归档过的会话，官方在发送这一步会静默拦住（消息进去、没有回复、也不报错），
      // 所以面板里先看它归没归档，归档了就摆个「恢复继续」。
      var archPair = useState('');
      var archMsg = archPair[0];
      var setArchMsg = archPair[1];
      useEffect(function () {
        var read = function () {
          var ws = Ctx && Ctx.workspaces;
          var snap = ws && ws.list && typeof ws.list.getSnapshot === 'function' ? ws.list.getSnapshot() : null;
          var list = (snap && snap.archivedSessionIds) || [];
          // 模拟问诊那边传自己的文案和按钮（点评完只能重开局，不许恢复继续）。
          setArchMsg(sessionId && list.indexOf(sessionId) >= 0
            ? (props.archivedText || '这一局已归档，恢复后才能接着问。')
            : '');
        };
        read();
        var ws = Ctx && Ctx.workspaces;
        if (ws && ws.list && typeof ws.list.subscribe === 'function') return ws.list.subscribe(read);
        return undefined;
        // 文案也要进依赖：收局那一刻 props.archivedText 才换过来，闭包不重读就会摆默认文案。
      }, [sessionId, props.archivedText]);
      var reviveArchived = function () {
        if (!sessionId) return;
        if (!Ctx || !Ctx.uiWorkspace || typeof Ctx.uiWorkspace.unarchiveSession !== 'function') {
          setArchMsg('会话服务不支持恢复');
          return;
        }
        Promise.resolve(Ctx.uiWorkspace.unarchiveSession(sessionId)).then(function () {
          setArchMsg('');
        }).catch(function (error) { setArchMsg('恢复失败：' + wbReason(error)); });
      };

      useEffect(function () {
        if (!sessionId) {
          setHold(null);
          return undefined;
        }
        var svc = wbSessions();
        if (!svc || typeof svc.retain !== 'function') {
          console.warn(WB_LOG + '会话服务不支持 retain，聊天区无法绑定');
          return undefined;
        }
        var alive = true;
        var ref = null;
        try {
          ref = svc.retain(sessionId, { source: 'tcmXueli' });
        } catch (error) {
          console.warn(WB_LOG + '绑定这一局失败：', wbReason(error));
          return undefined;
        }
        setHold({ id: sessionId, ref: ref });
        Promise.resolve(ref.ready).then(
          function () { if (alive) force(function (n) { return n + 1; }); },
          function (error) {
            if (!alive) return;
            console.warn(WB_LOG + '这一局打不开：', wbReason(error));
            setHold(null);
          },
        );
        return function () {
          alive = false;
          setHold(null);
          // 延后一拍再释放：这次提交里会话组件可能还在读它，立刻释放就报 released。
          setTimeout(function () {
            try { ref.release(); } catch (error) { /* 已释放 */ }
          }, 0);
        };
      }, [sessionId]);

      if (!sessionId) return null;
      if (!props.SessionProvider || !props.renderSlot) {
        return E('div', { className: 'xw-empty' },
          E('div', { className: 'xw-hint xw-err' }, '聊天区没接上（会话组件不可用）。从托盘完全退出 DSH 再启动一次。'));
      }
      if (!hold || hold.id !== sessionId) {
        return E('div', { className: 'xw-empty' }, E('div', { className: 'xw-hint' }, '正在打开这一局…'));
      }
      var ref = hold.ref;
      var drawn;
      var chatSlot = props.chatSlot || WB_CHAT_SLOT;
      // 同上：只接创建元素这一步的同步抛错；渲染期错误由宿主条目边界兜底。
      try {
        drawn = E(props.SessionProvider, { session: ref }, props.renderSlot(chatSlot, {}));
      } catch (error) {
        console.warn(WB_LOG + '聊天区渲染失败：', wbReason(error));
        drawn = E('div', { className: 'xw-hint xw-err' }, '聊天区没画出来：' + wbReason(error));
      }
      return E('div', { className: 'xw-chat' },
        archMsg ? E('div', { className: 'xw-arch' }, E('span', null, archMsg),
          E('button', {
            className: 'xw-mini',
            onClick: typeof props.onArchivedAction === 'function' ? props.onArchivedAction : reviveArchived,
          }, props.archivedActionLabel || '恢复继续')) : null,
        drawn);
    }

    // ── 医案（只读导入）组件 ─────────────────────────────────────────────────

    // MarkdownText 的文案配置：组件外建一次，身份稳定，不随每次渲染新建。
    var YIAN_MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

    /** 右栏只读医案查看器：头部标题＋创建/更新时间＋关闭，下面滚动区摆 Markdown 正文。 */
    function YianPane(props) {
      // 这层 try/catch 只接创建元素这一步的同步抛错；渲染期抛错由宿主边界接住，不拖垮工作台。
      try {
        var doc = props.doc || {};
        var meta = [];
        if (doc.created) meta.push('创建 ' + doc.created);
        if (doc.updated) meta.push('更新 ' + doc.updated);
        var bodyText = String(doc.body == null ? '' : doc.body);
        var bodyNode = null;
        if (ui && ui.MarkdownText) {
          try {
            bodyNode = E(ui.MarkdownText, { text: bodyText, labels: YIAN_MD_LABELS, omitHtml: true, variant: 'body' });
          } catch (error) { bodyNode = null; /* 画不出 Markdown 就降级纯文本 */ }
        }
        // 旧宿主没有 MarkdownText（或创建时抛错）：纯文本摆出来，绝不报错。
        if (!bodyNode) {
          bodyNode = E('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, bodyText);
        }
        return E('div', { className: 'xw-yian' },
          E('div', { className: 'xw-yian-head' },
            E('span', { className: 't', title: doc.title || doc.file }, doc.title || doc.file || '医案'),
            E('span', { className: 'm' }, meta.join(' · ')),
            E('button', { className: 'xw-btn', onClick: props.onClose }, '关闭')),
          E('div', { className: 'xw-yian-body' }, bodyNode));
      } catch (error) {
        console.warn(WB_LOG + '医案没画出来：', wbReason(error));
        return E('div', { className: 'xw-hint xw-err' }, '医案没画出来：' + wbReason(error));
      }
    }

    /** 医案选择器（纯展示，无 hooks）：列表/加载中/空/出错都由面板传进来。 */
    function YianPicker(props) {
      try {
        var st = props.state || { phase: 'loading', files: [], reason: '' };
        var inner;
        if (st.phase === 'loading') {
          inner = E('div', { className: 'xw-picker-note' }, '正在翻资料库的医案…');
        } else if (st.phase === 'err') {
          inner = E('div', { className: 'xw-picker-note xw-err' }, '医案列表没取到：' + (st.reason || '通道没应声'));
        } else if (st.phase === 'empty') {
          inner = E('div', { className: 'xw-picker-note' }, '资料库还没有医案。');
        } else {
          var files = Array.isArray(st.files) ? st.files : [];
          inner = files.filter(function (f) { return f && f.file; }).map(function (f) {
            var busy = props.busy === f.file;
            return E('div', { key: f.file, className: 'xw-picker-row' },
              E('div', { className: 't', title: f.title || f.file }, f.title || f.file),
              E('div', { className: 'm' }, wbTime(f.at)),
              E('button', {
                className: 'xw-mini',
                disabled: !!props.busy,
                onClick: function () {
                  if (props.busy) return;
                  props.onPick({ file: f.file, title: f.title || f.file, at: Number(f.at) || 0 });
                },
              }, busy ? '正在添加…' : '添加'));
          });
        }
        return E('div', { className: 'xw-mask', onClick: props.onClose },
          E('div', { className: 'xw-picker', onClick: function (e) { e.stopPropagation(); } },
            E('div', { className: 'xw-picker-head' },
              E('span', { className: 'grow' }, '挑一份医案'),
              E('button', { className: 'xw-btn', onClick: props.onClose }, '关闭')),
            E('div', { className: 'xw-picker-list' }, inner),
            props.err ? E('div', { className: 'xw-picker-note xw-err' }, props.err) : null));
      } catch (error) {
        console.warn(WB_LOG + '医案选择器没画出来：', wbReason(error));
        return E('div', { className: 'xw-picker-note xw-err' }, '医案选择器没画出来：' + wbReason(error));
      }
    }

    // ── 面板 ────────────────────────────────────────────────────────────────

function WbPanel(props) {
          var listState = useState([]);
          var rows = listState[0];
          var setRows = listState[1];
          var idState = useState(null);
          var sessionId = idState[0];
          var setSessionIdRaw = idState[1];
          var errState = useState('');
          var err = errState[0];
          var setErr = errState[1];
          var archShowPair = useState(false);
          var showArch = archShowPair[0];
          var setShowArch = archShowPair[1];
          var blankPair = useState(null);
          var blankId = blankPair[0];
          var setBlankId = blankPair[1];
          var qPair = useState('');
          var q = qPair[0];
          var setQ = qPair[1];
          var editPair = useState(null);
          var edit = editPair[0];
          var setEdit = editPair[1];
          var creatingPair = useState(false);
          var creating = creatingPair[0];
          var setCreating = creatingPair[1];

          // ── 医案（只读导入）状态 ──
          // 已导入清单：挂载时从 localStorage 载入（懒初始化，只读一次）。
          var yianListPair = useState(function () { return loadYianList(); });
          var yianList = yianListPair[0];
          var setYianList = yianListPair[1];
          // 正在看的医案：非空时右栏摆只读查看器，不摆聊天。
          var viewYianPair = useState(null);
          var viewYian = viewYianPair[0];
          var setViewYian = viewYianPair[1];
          var pickerPair = useState(false);
          var picker = pickerPair[0];
          var setPicker = pickerPair[1];
          // 选择器列表三态：loading / ok / empty / err。
          var pkPair = useState({ phase: 'loading', files: [], reason: '' });
          var pkState = pkPair[0];
          var setPkState = pkPair[1];
          var yianBusyPair = useState('');
          var yianBusy = yianBusyPair[0];
          var setYianBusy = yianBusyPair[1];
          var yianErrPair = useState('');
          var yianErr = yianErrPair[0];
          var setYianErr = yianErrPair[1];
          // 卸载后不再 setState：fetch 回话晚于卸载时靠它挡住。
          var wbAlive = React.useRef(true);
          // 换局即退出医案查看：包一层 setter，点会话行/新建会话/删局后重开都顺带清 viewYian。
          var setSessionId = function (id) { setViewYian(null); setSessionIdRaw(id); };
    
          // 扫一遍客户端会话快照：挑出本模式的会话；空白会话单独留一个待复用，
          // 免得每次点进来都新建一局空的。
          var scan = function () {
            var svc = wbSessions();
            if (!svc || !svc.list || typeof svc.list.getSnapshot !== 'function') return null;
            var snap = svc.list.getSnapshot();
            var ids = (snap && snap.ids) || [];
            var ws = Ctx && Ctx.workspaces;
            var wsnap = ws && ws.list && typeof ws.list.getSnapshot === 'function' ? ws.list.getSnapshot() : null;
            var archivedIds = (wsnap && wsnap.archivedSessionIds) || [];
            var archivedSet = {};
            for (var a = 0; a < archivedIds.length; a += 1) archivedSet[archivedIds[a]] = true;
            var out = [];
            var blankId = null;
            for (var i = 0; i < ids.length; i += 1) {
              var row = snap.byId ? snap.byId[ids[i]] : null;
              if (!row || row.parentId || row.origin === 'subagent') continue;
              var isArch = !!archivedSet[ids[i]];
              if (isArch && !showArch) continue;
              var preset = row.projectionValues && row.projectionValues.agentPreset;
              if (preset !== WB_PRESET) continue;
              if (row.blank) {
                if (!blankId) blankId = ids[i];
                continue;
              }
              var title = row.title || row.displayTitle || '';
              // 问诊局不混进学习版的历史列表：它们关面板就收走，不在这里留痕。
              // 局限（如实说明）：认局靠标题前缀——宿主 create 没有插件可写的元数据（详见 teScan 注释），
              // 官方会话页改名丢了前缀，这一局就会混回本列表。
              if (String(title).indexOf('问诊·局') === 0) continue;
              // 答疑的局归「讲解答疑」面板自己那仿历史，不混进这一侧。
              if (String(title).indexOf('答疑·') === 0) continue;
              out.push({
                id: ids[i],
                title: title,
                at: row.updatedAt || 0,
                archived: isArch,
              });
            }
            out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
            return { rows: out, blankId: blankId };
          };
    
          var load = function () {
            var got = scan();
            if (!got) {
              setErr('会话列表还取不到：从托盘完全退出 DSH 再启动一次。');
              return null;
            }
            setRows(got.rows);
            setBlankId(got.blankId || null);
            setErr('');
            return got;
          };
    
          // 右侧固定是一局「新会话」：有空白会话就复用，没有才建。
          // creating 闸与另两个面板的 busy 对齐：建会话没回话前不许再点，免得连建几局。
          var openFresh = function (knownBlankId) {
            if (creating) return;
            if (knownBlankId) {
              setSessionId(knownBlankId);
              return;
            }
            var svc = wbSessions();
            if (!svc || typeof svc.create !== 'function') {
              setErr('会话服务不可用：从托盘完全退出 DSH 再启动一次。');
              return;
            }
            setCreating(true);
            wbTimeout(svc.create({ agentPreset: WB_PRESET }), 20000, '建会话')
              .then(function (made) {
                setCreating(false);
                var id = typeof made === 'string' ? made : made && made.id;
                if (id) setSessionId(id);
                load();
              })
              .catch(function (error) {
                setCreating(false);
                setErr('开新会话失败：' + wbReason(error));
              });
          };
    
          useEffect(function () {
            wbAlive.current = true;
            wbCss();
            // 一进来就是新会话页，不自动翻开历史那一局。
            var first = load();
            if (first) openFresh(first.blankId);
            var svc = wbSessions();
            var stops = [];
            if (svc && svc.list && typeof svc.list.subscribe === 'function') stops.push(svc.list.subscribe(function () { load(); }));
            // 归档会写到 workspaces 那份状态里，列表要跟着它一起重排。
            var ws = Ctx && Ctx.workspaces;
            if (ws && ws.list && typeof ws.list.subscribe === 'function') stops.push(ws.list.subscribe(function () { load(); }));
            // 医案这边没加新定时器/订阅，只有 fetch 回话：卸载时置 wbAlive=false 挡住晚到的 setState。
            return function () { wbAlive.current = false; for (var i = 0; i < stops.length; i += 1) { try { stops[i](); } catch (error) { /* 已退订 */ } } };
          }, []);
    
          useEffect(function () { load(); }, [showArch]);

          var newOne = function () {
            var got = load() || { blankId: null };
            openFresh(got.blankId);
          };
    
          var openInChat = function (maybeId) {
            var id = maybeId || sessionId;
            if (!id) return;
            setViewYian(null); // 去聊天页也退出医案查看
            try {
              Ctx.uiWorkspace.openSession(id);
              Ctx.layout.selectPanel(null);
            } catch (error) {
              setErr('打开会话失败：' + wbReason(error));
            }
          };
    
          var doRename = function (id, title) {
            var svc = wbSessions();
            var text = String(title === undefined ? '' : title).trim();
            setEdit(null);
            if (!text) { setErr('名字不能是空的'); return; }
            if (!svc || typeof svc.using !== 'function') { setErr('会话服务不支持改名'); return; }
            Promise.resolve(svc.using(id, { source: 'qihuangWorkbench' }, function (ref) {
              return Promise.resolve(ref.ready).then(function (bound) {
                return bound.session.rename(text);
              });
            })).then(function () { load(); })
              .catch(function (error) { setErr('改名失败：' + wbReason(error)); });
          };
    
          var doRestore = function (id) {
            if (!Ctx || !Ctx.uiWorkspace || typeof Ctx.uiWorkspace.unarchiveSession !== 'function') {
              setErr('会话服务不支持恢复');
              return;
            }
            Promise.resolve(Ctx.uiWorkspace.unarchiveSession(id))
              .then(function () { load(); })
              .catch(function (error) { setErr('恢复失败：' + wbReason(error)); });
          };

          // 真删：宿主没有删会话的接口，走插件自己的通道（只认本插件预设、本机页面发来的请求）。
          var doDelete = function (id) {
            setEdit(null);
            setErr('');
            Promise.resolve(fetch('/dsh-tcm-xueli/teach-end?doing=delete&session=' + encodeURIComponent(id), {
              credentials: 'same-origin',
            })).then(function (res) { return res.json(); })
              .then(function (got) {
                if (!got || !got.ok) {
                  setErr('没删掉：' + String((got && got.reason) || '通道没应声'));
                  return;
                }
                setRows(function (old) { return old.filter(function (row) { return row.id !== id; }); });
                if (id === sessionId) openFresh(null);
                // 别等宿主回话；再让列表重新拉一遍，刚删掉的那局不会又冒出来。
                var svc = wbSessions();
                if (svc && svc.list && typeof svc.list.refresh === 'function') {
                  Promise.resolve(svc.list.refresh()).then(function () { load(); }, function () { load(); });
                } else {
                  load();
                }
              })
              .catch(function (error) { setErr('删除失败：' + wbReason(error)); });
          };
    
          var doRemove = function (id) {
            setEdit(null);
            if (!Ctx || !Ctx.uiWorkspace || typeof Ctx.uiWorkspace.archiveSession !== 'function') {
              setErr('会话服务不支持归档');
              return;
            }
            Promise.resolve(Ctx.uiWorkspace.archiveSession(id, { stopActivity: true }))
              .then(function () {
                // 先从本地列表拿掉，别等宿主回话；再让列表重新拉一遍。
                setRows(function (old) { return old.filter(function (row) { return row.id !== id; }); });
                var svc = wbSessions();
                if (svc && svc.list && typeof svc.list.refresh === 'function') {
                  Promise.resolve(svc.list.refresh()).then(function () { load(); }, function () { /* 拉不动就保持现状 */ });
                } else {
                  load();
                }
                if (id === sessionId) openFresh(null);
              })
              .catch(function (error) { setErr('归档失败：' + wbReason(error)); });
          };

          // ── 医案（只读导入）操作 ──
          // 打开选择器：现 fetch 资料库医案列表，加载中/空/出错三态都摆出来。
          var openPicker = function () {
            setPicker(true);
            setYianErr('');
            setPkState({ phase: 'loading', files: [], reason: '' });
            yianGet('/dsh-tcm-xueli/yian').then(function (got) {
              if (!wbAlive.current) return;
              if (!got || !got.ok) {
                setPkState({ phase: 'err', files: [], reason: String((got && got.reason) || '通道没应声') });
                return;
              }
              var files = Array.isArray(got.files) ? got.files : [];
              setPkState({ phase: files.length ? 'ok' : 'empty', files: files, reason: '' });
            }).catch(function (error) {
              if (!wbAlive.current) return;
              setPkState({ phase: 'err', files: [], reason: wbReason(error) });
            });
          };

          // fetch 一份医案正文并在右栏只读打开。失败把 reason 摆出来，不静默吞。
          var openYianDoc = function (entry) {
            if (!entry || !entry.file) return Promise.resolve(false);
            if (yianBusy) return Promise.resolve(false); // 上一份还没打开，别连点
            setYianErr('');
            setYianBusy(entry.file);
            return yianGet('/dsh-tcm-xueli/yian?file=' + encodeURIComponent(entry.file)).then(function (got) {
              if (!wbAlive.current) return false;
              setYianBusy('');
              if (!got || !got.ok) {
                setYianErr('医案没打开：' + String((got && got.reason) || '通道没应声'));
                return false;
              }
              setViewYian({
                file: got.file || entry.file,
                title: got.title || entry.title || entry.file,
                body: String(got.body == null ? '' : got.body),
                created: String(got.created || ''),
                updated: String(got.updated || ''),
              });
              return true;
            }).catch(function (error) {
              if (!wbAlive.current) return false;
              setYianBusy('');
              setYianErr('医案没打开：' + wbReason(error));
              return false;
            });
          };

          // 选择器点「添加」：先记清单并落盘，再 fetch 正文只读打开，成功后关选择器。
          var addYian = function (entry) {
            var next = yianAddToList(yianList, entry);
            setYianList(next);
            persistYianList(next);
            return openYianDoc(entry).then(function (okFlag) {
              if (okFlag && wbAlive.current) setPicker(false);
              return okFlag;
            });
          };

          // 医案行点「×」：只从已导入清单拿掉记录，绝不删资料库里的文件（不走任何删除通道）。
          var removeYian = function (file) {
            var next = yianList.filter(function (it) { return it.file !== file; });
            setYianList(next);
            persistYianList(next);
            if (viewYian && viewYian.file === file) setViewYian(null);
          };

          // 左侧第一行永远是右侧这一局的名字，好知道现在聊的是哪一局。
          var currentTitle = '新会话';
          for (var k = 0; k < rows.length; k += 1) {
            if (rows[k].id === sessionId) currentTitle = rows[k].title || '（没起标题的会话）';
          }
          // 正在看医案时，顶部显示医案标题。
          if (viewYian) currentTitle = viewYian.title || viewYian.file || '医案';
          var word = String(q || '').trim().toLowerCase();
          var shown = rows.filter(function (row) {
            if (!word) return true;
            return String(row.title || '').toLowerCase().indexOf(word) >= 0;
          });
          // 医案区同样受搜索框过滤。
          var yianShown = yianList.filter(function (it) {
            if (!word) return true;
            return String(it.title || it.file || '').toLowerCase().indexOf(word) >= 0;
          });
    
          var rowView = function (row) {
            var isOn = row.id === sessionId;
            var editing = edit && edit.id === row.id;
            if (editing && edit.kind === 'rename') {
              return E('div', { key: row.id, className: 'xw-item on' },
                E('input', {
                  className: 'xw-inline',
                  autoFocus: true,
                  value: edit.text,
                  onChange: function (e) { setEdit({ id: row.id, kind: 'rename', text: e.target.value }); },
                  onKeyDown: function (e) {
                    if (e.key === 'Enter') doRename(row.id, edit.text);
                    if (e.key === 'Escape') setEdit(null);
                  },
                }),
                E('div', { className: 'xw-ops' },
                  E('button', { className: 'xw-mini', onClick: function () { doRename(row.id, edit.text); } }, '保存'),
                  E('button', { className: 'xw-mini', onClick: function () { setEdit(null); } }, '取消')));
            }
            if (editing && edit.kind === 'remove') {
              return E('div', { key: row.id, className: 'xw-item on' },
                E('div', { className: 't' }, '归档「' + (row.title || '这一局') + '」？'),
                E('div', { className: 'm' }, '归档后从列表里收起来，还能在归档里找回。'),
                E('div', { className: 'xw-ops' },
                  E('button', { className: 'xw-mini danger', onClick: function () { doRemove(row.id); } }, '确定归档'),
                  E('button', { className: 'xw-mini', onClick: function () { setEdit(null); } }, '取消')));
            }
            if (editing && edit.kind === 'delete') {
              return E('div', { key: row.id, className: 'xw-item on' },
                E('div', { className: 't' }, '删除「' + (row.title || '这一局') + '」？'),
                E('div', { className: 'm' }, '删了就找不回来，连聊天记录一起清掉；只是不想看见，用「归档」更稳。'),
                E('div', { className: 'xw-ops' },
                  E('button', { className: 'xw-mini danger', onClick: function () { doDelete(row.id); } }, '确定删除'),
                  E('button', { className: 'xw-mini', onClick: function () { setEdit(null); } }, '取消')));
            }
            return E('div', {
              key: row.id,
              className: 'xw-item' + (isOn ? ' on' : ''),
              onClick: function () { setSessionId(row.id); },
              title: row.title,
            },
              E('div', { className: 't' }, row.title || '（没起标题的会话）'),
              E('div', { className: 'm' }, wbTime(row.at), row.archived ? E('span', { className: 'xw-tag' }, '已归档') : null),
              E('div', { className: 'xw-ops' },
                row.archived
                  ? E('button', {
                    className: 'xw-mini',
                    title: '恢复',
                    onClick: function (e) { e.stopPropagation(); doRestore(row.id); },
                  }, '恢复')
                  : E('button', {
                    className: 'xw-mini',
                    title: '改名',
                    onClick: function (e) { e.stopPropagation(); setEdit({ id: row.id, kind: 'rename', text: row.title || '' }); },
                  }, '改名'),
                row.archived ? null : E('button', {
                  className: 'xw-mini danger',
                  title: '归档',
                  onClick: function (e) { e.stopPropagation(); setEdit({ id: row.id, kind: 'remove' }); },
                }, '归档'),
                E('button', {
                  className: 'xw-mini danger',
                  title: '删除',
                  onClick: function (e) { e.stopPropagation(); setEdit({ id: row.id, kind: 'delete' }); },
                }, '删除')));
          };

          // 医案行：点整行只读打开；「×」只从清单移除，不删资料库文件（有别于会话的删除）。
          var yianRowView = function (it) {
            var isOn = !!(viewYian && viewYian.file === it.file);
            return E('div', {
              key: 'yian:' + it.file,
              className: 'xw-item' + (isOn ? ' on' : ''),
              onClick: function () { openYianDoc(it); },
              title: it.title || it.file,
            },
              E('div', { className: 't' }, it.title || it.file),
              E('div', { className: 'm' }, wbTime(it.at)),
              E('div', { className: 'xw-ops' },
                E('button', {
                  className: 'xw-mini',
                  title: '从清单移除（不删资料库里的文件）',
                  onClick: function (e) { e.stopPropagation(); removeYian(it.file); },
                }, '×')));
          };

          return E('div', { className: 'xw-wrap' },
            E('div', { className: 'xw-head' },
              E('span', { className: 'xw-brand' }, WB_TITLE),
              E('button', { className: 'xw-btn pri', onClick: newOne, disabled: creating }, creating ? '正在开…' : '新建会话'),
              E('button', { className: 'xw-btn', onClick: openPicker }, '添加医案'),
              E('button', { className: 'xw-btn', onClick: openInChat, disabled: !sessionId }, '去聊天页'),
              E('button', { className: 'xw-btn' + (showArch ? ' on' : ''), onClick: function () { setShowArch(!showArch); } }, showArch ? '收起归档' : '显示已归档'),
              E('button', { className: 'xw-btn', onClick: load }, '刷新')),
            E('div', { className: 'xw-body' },
              E('div', { className: 'xw-side' },
                E('input', {
                  className: 'xw-search',
                  placeholder: '搜索会话',
                  value: q,
                  onChange: function (e) { setQ(e.target.value); },
                }),
                E('div', { className: 'xw-now', title: currentTitle },
                  E('span', { className: 'dot' }),
                  E('span', { className: 'name' }, currentTitle)),
                E('div', { className: 'xw-items' },
                  shown.length === 0
                    ? E('div', { className: 'xw-hint', style: { padding: '10px 9px' } },
                      word ? '没有匹配的会话。' : '还没有历史会话，右边就是新开的一局。')
                    : shown.map(rowView),
                  // 医案区：清单里有才显示；同样受搜索框过滤。
                  yianList.length > 0
                    ? E('div', { className: 'xw-ysec' }, '医案')
                    : null,
                  yianList.length > 0
                    ? (yianShown.length === 0
                      ? E('div', { className: 'xw-hint', style: { padding: '6px 9px' } }, '没有匹配的医案。')
                      : yianShown.map(yianRowView))
                    : null)),
              E('div', { className: 'xw-main' },
                err ? E('div', { className: 'xw-hint xw-err', style: { padding: '8px 12px' } }, err) : null,
                yianErr ? E('div', { className: 'xw-hint xw-err', style: { padding: '8px 12px' } }, yianErr) : null,
                yianBusy && !viewYian ? E('div', { className: 'xw-hint', style: { padding: '8px 12px' } }, '正在打开医案…') : null,
                // 正在看医案：右栏只摆只读查看器，不摆聊天/欢迎页。
                viewYian
                  ? E(YianPane, { doc: viewYian, onClose: function () { setViewYian(null); } })
                  : null,
                !viewYian && sessionId && sessionId === blankId
                  ? E('div', { className: 'xw-welcome' },
                    E('div', { className: 'big' }, '欢迎使用经方学习版。'),
                    E('div', { className: 'line' }, '可以帮您分析病症，也可以点评您现有的处方。'),
                    E('div', { className: 'rule' }, '把症状，或者手上的方子，写进下面输入框就能开始。'))
                  : null,
                !viewYian && sessionId
                  ? E(WbChatPane, {
                    sessionId: sessionId,
                    renderSlot: props.renderSlot,
                    renderFactorySlot: props.renderFactorySlot,
                    SessionProvider: props.SessionProvider,
                  })
                  : null,
                !viewYian && !sessionId
                  ? E('div', { className: 'xw-empty' },
                    E('div', { className: 'big' }, WB_TITLE),
                    E('div', { className: 'xw-hint' }, '右边这一局就是新会话，直接说话就能开始聊。'))
                  : null)),
            // 医案选择器：覆盖层，盖在整个面板上。
            picker
              ? E(YianPicker, {
                state: pkState,
                busy: yianBusy,
                err: yianErr,
                onClose: function () { setPicker(false); },
                onPick: addYian,
              })
              : null);
        }

    function WbIcon() {
      return E('svg', {
        width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        E('rect', { x: 2.6, y: 2.6, width: 14.8, height: 14.8, rx: 3.6, stroke: 'currentColor', strokeWidth: 1.35 }),
        E('text', {
          x: 10, y: 14.3, textAnchor: 'middle', fontSize: 10.4,
          fill: 'currentColor', fontFamily: 'inherit',
        }, '学'));
    }

    // 官方左侧会话列表里不显示问诊局：DSH 列表只看 origin/blank，没有「隐藏」接口，
    // 所以从 DOM 层把标题带「问诊·局」的那几行藏掉。类名变了最多藏不住，不影响主体。
    var simHideTimer = null;
    // 问诊局开过的会话 id 记一份，靠它精确隐藏（标题被截断也能认出来）。
    var simRoundIds = {};
    // 「去会话页」送走的局：从隐藏集合挪进这份豁免集合，回到官方左栏可见。
    // 这份集合落 localStorage（见 loadShownIds/persistShownIds），刷新/重启后这些局仍可见，不会又被藏回去。
    var simShownIds = {};

    /** 拼进 CSS 选择器的会话 id 必须过这道闸：只认字母数字下划线连字符，防注入。 */
    var SIM_ID_SAFE = /^[A-Za-z0-9_-]+$/;
    function simIdSafe(id) {
      return typeof id === 'string' && SIM_ID_SAFE.test(id);
    }

    // 豁免集合持久化：浏览器 localStorage 存一份会话 id 清单，刷新/重启后载入。
    // 非浏览器环境（测试/SSR）没有 localStorage 就静默跳过，内存里这份照常工作。
    var SIM_SHOWN_KEY = NS + ':simShown';
    var SIM_SHOWN_KEEP = 200; // 最多留最近 200 个，免得常年累月攒爆 localStorage。
    function loadShownIds() {
      var out = {};
      try {
        if (typeof localStorage === 'undefined') return out;
        var raw = localStorage.getItem(SIM_SHOWN_KEY);
        if (!raw) return out;
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (var i = 0; i < arr.length; i += 1) { if (simIdSafe(arr[i])) out[arr[i]] = true; }
        }
      } catch (error) { /* 读不到/读坏了就当空，不影响主体 */ }
      return out;
    }
    function persistShownIds(set) {
      try {
        if (typeof localStorage === 'undefined') return;
        var ids = [];
        for (var id in set) { if (set[id] === true && simIdSafe(id)) ids.push(id); }
        localStorage.setItem(SIM_SHOWN_KEY, JSON.stringify(ids.slice(-SIM_SHOWN_KEEP)));
      } catch (error) { /* 写不进就算了，内存里这份仍然有效 */ }
    }
    // 原地载入持久化的豁免集合（不重新赋值，__test 暴露的活引用始终有效）。
    (function () {
      var saved = loadShownIds();
      for (var k in saved) { simShownIds[k] = saved[k]; }
    })();

    /** 把一局记进隐藏集合（只收合法 id）。 */
    function simHideAdd(set, id) {
      if (simIdSafe(id)) set[id] = true;
      return set;
    }

    /** 「去会话页」：移出隐藏集合、记入豁免集合，这一局回到官方左栏。 */
    function simHideRelease(hideSet, shownSet, id) {
      if (!simIdSafe(id)) return;
      delete hideSet[id];
      shownSet[id] = true;
      persistShownIds(shownSet); // 落盘，刷新/重启后这一局仍留在官方左栏。
    }

    /** 这一局是否豁免隐藏（已被送去会话页）。 */
    function simHideExempt(shownSet, id) {
      return shownSet[id] === true;
    }

    /** 消费一次显式收局豁免标记：置位就清掉并返回 true（这次 cleanup 不再收局）。 */
    function takeSkipFlag(ref) {
      if (ref && ref.current === true) { ref.current = false; return true; }
      return false;
    }

    // 这个插件自己的会话全部不在官方左栏出现：学习版有自己的工作台，
    // 官方左栏只留普通会话，免得一屏全是问诊局。
    function ownPresetIds() {
      var out = {};
      try {
        var svc = wbSessions();
        var snap = svc && svc.list && typeof svc.list.getSnapshot === 'function' ? svc.list.getSnapshot() : null;
        if (!snap) return out;
        var ids = snap.ids || [];
        for (var i = 0; i < ids.length; i += 1) {
          var row = snap.byId ? snap.byId[ids[i]] : null;
          var preset = row && row.projectionValues && row.projectionValues.agentPreset;
          if (preset === WB_PRESET) out[ids[i]] = true;
        }
      } catch (error) { /* 读不到就只按标题认 */ }
      return out;
    }

    function isSimTitle(text) {
      var t = String(text || '');
      return t.indexOf('问诊·局') >= 0 || t.indexOf('模拟问诊 · 局') >= 0;
    }

    // 官方左栏没有过滤接口，就注入一条样式表按会话行标记把本插件的会话藏掉。
    // 样式表是声明式的：React 重渲染抹不掉，不会像改内联样式那样一闪一闪。
    function ownHideStyle() {
      if (typeof document === 'undefined' || !document.head) return null;
      var el = document.getElementById('xw-hide-sim');
      if (!el) {
        el = document.createElement('style');
        el.id = 'xw-hide-sim';
        el.setAttribute('data-plugin', NS);
        document.head.appendChild(el);
      }
      return el;
    }

    function hideSimRows() {
      try {
        var el = ownHideStyle();
        if (!el) return;
        var own = ownPresetIds();
        var ids = own;
        for (var sid in simRoundIds) { if (simRoundIds[sid] === true) ids[sid] = true; }
        var css = '';
        for (var id in ids) {
          if (ids[id] !== true) continue;
          // 送去会话页的局豁免：它已回到官方左栏，不能再藏。
          if (simHideExempt(simShownIds, id)) continue;
          // id 直拼选择器前先过校验，不合格的跳过，别让怪 id 撕坏样式表。
          if (!simIdSafe(id)) continue;
          css += '[data-row-key="session:' + id + '"]{display:none !important}';
        }
        if (el.textContent !== css) el.textContent = css;
      } catch (error) { /* 藏不住就算了 */ }
    }

    var simLate = [];

    function laterHideSimRows(ms) {
      var handle = setTimeout(hideSimRows, ms);
      simLate.push(handle);
      try { if (handle && typeof handle.unref === 'function') handle.unref(); } catch (error) { /* 没有就算了 */ }
    }

    function startHideSimRows() {
      if (simHideTimer) return;
      hideSimRows();
      laterHideSimRows(300);
      laterHideSimRows(1500);
      // 900ms 轮询保持不动：改订阅驱动要动宿主左栏的渲染时序，风险大，本次不做。
      simHideTimer = setInterval(hideSimRows, 900);
      // 测试或非浏览器环境下别让这个定时器吊住进程。
      try { if (simHideTimer && typeof simHideTimer.unref === 'function') simHideTimer.unref(); } catch (error) { /* 没有就算了 */ }
    }

    // 插件卸载或热重载时停掉定时器，否则它会一直去改官方左栏的 DOM。
    function stopHideSimRows() {
      if (simHideTimer) {
        try { clearInterval(simHideTimer); } catch (error) { /* 没有就算了 */ }
        simHideTimer = null;
      }
      for (var i = 0; i < simLate.length; i += 1) {
        try { clearTimeout(simLate[i]); } catch (error) { /* 没有就算了 */ }
      }
      simLate = [];
      // 隐藏样式和两份集合都是插件渲染期自己注入的，宿主不认领不回收：
      // 卸载时一并清掉，否则插件停用后官方左栏的会话被永久藏住。
      // 原地清（不重新赋值），__test 暴露的活引用才不会失效。
      // 注意：simShownIds 的 localStorage 副本这里不清——下次启动 loadShownIds 会载入，
      // 「去会话页」的豁免才能跨刷新/重启保留；插件真停用时样式已摘，残留清单也无害。
      for (var rid in simRoundIds) { delete simRoundIds[rid]; }
      for (var sid2 in simShownIds) { delete simShownIds[sid2]; }
      try {
        if (typeof document !== 'undefined') {
          var el = document.getElementById('xw-hide-sim');
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }
      } catch (error) { /* 摘不掉也不影响宿主 */ }
    }

    /** 卸载时按标记摘掉本插件注入的全部 style（wb/sr/sim/te/hide 都打了 data-plugin）。 */
    function removePluginStyles() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
        var list = document.querySelectorAll('style[data-plugin="' + NS + '"]');
        for (var i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].parentNode) list[i].parentNode.removeChild(list[i]);
        }
      } catch (error) { /* 摘不掉也不影响宿主 */ }
    }

    function wbRegister(ctx) {
      // 只声明我们自己的子插槽（放这一局的聊天视图），scope 用 session，
      // 渲染引擎才会把 SessionProvider 注入进来，面板才能圈定「这一局」。
      var decl = {};
      decl[WB_CHAT_SLOT] = { kind: 'single', scope: 'session' };
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: WB_PANEL, children: decl }, WbPanel);
      });
      ctx.slots.inject(WB_CHAT_SLOT, function () {
        return ctx.slots.register({ name: WB_CHAT_SLOT }, WbChatSlot);
      });
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({ name: 'sidebar.panellist', id: WB_PANEL, order: 21, label: function () { return '经方学习版'; } }, WbIcon);
      });
    }

var SR_PANEL = 'xueli-search';
        var SR_PATH = '/dsh-tcm-xueli/search';
        var SR_TITLE = '资料查询';
    
        function srCss() {
          if (typeof document === 'undefined') return;
          if (document.getElementById('sr-style')) return;
          var style = document.createElement('style');
          style.id = 'sr-style';
          style.setAttribute('data-plugin', NS);
          style.textContent = [
            '.sr-wrap{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px}',
            '.sr-head{display:flex;align-items:center;gap:10px;padding:12px 14px 0;flex:none}',
            '.sr-head-text{min-width:0}',
            '.sr-book{flex:none;display:block}',
            '.sr-brand{font-weight:600;font-size:14px}',
            '.sr-sub{font-size:11.5px;opacity:.6;margin-top:1px}',
            '.sr-bar{display:flex;gap:8px;padding:10px 14px;flex:none}',
            '.sr-input{flex:1;min-width:0;padding:7px 10px;font-size:13px;border:1px solid rgba(127,127,127,.32);border-radius:7px;background:transparent;color:inherit;outline:none}',
            '.sr-input:focus{border-color:#3b6ef5}',
            '.sr-btn{border:1px solid #3b6ef5;background:#3b6ef5;color:#fff;border-radius:7px;padding:6px 16px;font-size:12.5px;cursor:pointer}',
            '.sr-btn:disabled{opacity:.6;cursor:default}',
            '.sr-list{flex:1;min-height:0;overflow-y:auto;padding:0 14px 14px}',
            '.sr-card{border:1px solid rgba(127,127,127,.2);border-radius:9px;padding:10px 12px;margin-bottom:10px}',
            '.sr-src{font-size:11.5px;opacity:.6;margin-bottom:6px}',
            '.sr-label{font-size:11px;opacity:.55;margin:8px 0 2px}',
            '.sr-meta-line{font-size:12.5px;line-height:1.8;margin-bottom:2px}',
            '.sr-meta-k{opacity:.55;margin-right:8px}',
            '.sr-orig{font-size:13px;line-height:1.75;white-space:pre-wrap}',
            '.sr-plain{font-size:13px;line-height:1.75;white-space:pre-wrap;color:inherit;opacity:.92}',
            '.sr-hint{font-size:12px;opacity:.62;line-height:18px;padding:2px 0}',
            '.sr-err{font-size:12px;color:#d9534f;line-height:18px;padding:0 14px 6px}',
            '.sr-acu-head{display:flex;align-items:baseline;gap:8px;margin:2px 0 6px}',
            '.sr-acu-name{font-size:16px;font-weight:600}',
            '.sr-acu-py{font-size:11px;opacity:.55;letter-spacing:.5px}',
            '.sr-acu-img{width:100%;max-width:440px;height:auto;display:block;border-radius:8px;background:#fff;border:1px solid rgba(127,127,127,.16)}',
            '.sr-acu-note{font-size:11px;opacity:.5;margin-top:6px;line-height:1.6}',
          ].join('');
          document.head.appendChild(style);
        }
    
        /** 资料查询的小图：一本摊开的线装书，红书签。同色系，跟穴位图一个味道。 */
        function SrBook(props) {
          var size = (props && props.size) || 40;
          return E('svg', {
            className: 'sr-book', width: size, height: size, viewBox: '0 0 100 100',
            xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
          },
            E('circle', { cx: 50, cy: 50, r: 48, fill: '#f7f1e8', stroke: '#d8c8b4', strokeWidth: 1.2 }),
            E('path', { d: 'M50 38 C38 31 24 29 13 32 L13 70 C24 67 38 69 50 76 Z', fill: '#fdf8f1', stroke: '#c2b09a', strokeWidth: 1.3 }),
            E('path', { d: 'M50 38 C62 31 76 29 87 32 L87 70 C76 67 62 69 50 76 Z', fill: '#fdf8f1', stroke: '#c2b09a', strokeWidth: 1.3 }),
            E('path', { d: 'M50 38 L50 76', stroke: '#c2b09a', strokeWidth: 1.3, fill: 'none' }),
            E('path', { d: 'M22 41 C30 40 38 42 44 45 M22 49 C30 48 38 50 44 53 M22 57 C30 56 38 58 44 61', stroke: '#e0d3c0', strokeWidth: 1.3, fill: 'none', strokeLinecap: 'round' }),
            E('path', { d: 'M78 41 C70 40 62 42 56 45 M78 49 C70 48 62 50 56 53 M78 57 C70 56 62 58 56 61', stroke: '#e0d3c0', strokeWidth: 1.3, fill: 'none', strokeLinecap: 'round' }),
            E('path', { d: 'M62 30 L62 46 L67 42 L72 46 L72 30', fill: '#c0392b', opacity: 0.78 }));
        }

        function SrIcon() {
          return E('svg', {
            width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
          },
            E('rect', { x: 2.6, y: 2.6, width: 14.8, height: 14.8, rx: 3.6, stroke: 'currentColor', strokeWidth: 1.35 }),
            E('text', {
              x: 10, y: 14.3, textAnchor: 'middle', fontSize: 10.4,
              fill: 'currentColor', fontFamily: 'inherit',
            }, '查'));
        }
    
        function SrPanel() {
          var qState = useState('');
          var q = qState[0];
          var setQ = qState[1];
          var busyState = useState(false);
          var busy = busyState[0];
          var setBusy = busyState[1];
          var resState = useState([]);
          var res = resState[0];
          var setRes = resState[1];
          var noteState = useState('');
          var note = noteState[0];
          var setNote = noteState[1];
          var errState = useState('');
          var err = errState[0];
          var setErr = errState[1];
    
          useEffect(function () { srCss(); }, []);
    
          var run = function () {
            var text = String(q || '').trim();
            if (!text) { setErr('先输入要查的字，比如「便秘」「少阴病」「足三里」。'); return; }
            setBusy(true);
            setErr('');
            setNote('');
            Promise.resolve()
              .then(function () {
                return fetch(SR_PATH + '?q=' + encodeURIComponent(text) + '&n=6', { cache: 'no-store' });
              })
              .then(function (resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
              })
              .then(function (back) {
                setBusy(false);
                var got = back && Array.isArray(back.results) ? back.results : [];
                setRes(got);
                setNote(back && back.reason ? String(back.reason) : '');
              })
              .catch(function (error) {
                setBusy(false);
                setErr('查询没通：' + (error && error.message ? error.message : String(error)) + '。重启一次 DSH 再试。');
              });
          };
    
          var metaRows = function (row) {
            var meta = row.meta;
            if (!meta) return null;
            var lines = [];
            if (meta.nature) lines.push(['性味', meta.nature]);
            if (meta.effect) lines.push(['功效', meta.effect]);
            if (meta.origin) lines.push(['产地', meta.origin]);
            if (meta.alias) lines.push(['别名', meta.alias]);
            if (!lines.length) return null;
            return E('div', {}, lines.map(function (pair, k) {
              return E('div', { className: 'sr-meta-line', key: k },
                E('span', { className: 'sr-meta-k' }, pair[0]),
                E('span', { className: 'sr-meta-v' }, pair[1]));
            }));
          };

          var acuCard = function (acu, i) {
            return E('div', { className: 'sr-card', key: i },
              E('div', { className: 'sr-src' }, '穴位图 · ' + (acu.meridian || '') ),
              E('div', { className: 'sr-acu-head' },
                E('span', { className: 'sr-acu-name' }, acu.name || ''),
                acu.py ? E('span', { className: 'sr-acu-py' }, acu.py) : null),
              E('img', {
                className: 'sr-acu-img',
                src: acu.image,
                alt: (acu.name || '') + ' 穴位图',
                loading: 'lazy',
                width: 440,
                height: 400,
              }),
              acu.location ? E('div', { className: 'sr-meta-line' },
                E('span', { className: 'sr-meta-k' }, '定位'), E('span', {}, acu.location)) : null,
              acu.func ? E('div', { className: 'sr-meta-line' },
                E('span', { className: 'sr-meta-k' }, '主治'), E('span', {}, acu.func)) : null,
              E('div', { className: 'sr-acu-note' },
                '示意图 · 腧穴定位据 GB/T 12346—2021；坐标整理自 Honglouqaz/tcm-meridian-3d（CC BY 4.0）'));
          };

          var card = function (row, i) {
            if (row && row.acupoint) return acuCard(row.acupoint, i);
            return E('div', { className: 'sr-card', key: i },
              E('div', { className: 'sr-src' }, row.source || '资料库'),
              metaRows(row),
              E('div', { className: 'sr-label' }, '原文'),
              E('div', { className: 'sr-orig' }, row.original || ''),
              row.plain ? E('div', { className: 'sr-label' }, '白话') : null,
              row.plain
                ? E('div', { className: 'sr-plain' }, row.plain)
                : (row.meta ? null : E('div', { className: 'sr-hint' }, '这段的白话没译出来，先看原文。')));
          };
    
          return E('div', { className: 'sr-wrap' },
            E('div', { className: 'sr-head' },
              E(SrBook, { size: 40 }),
              E('div', { className: 'sr-head-text' },
                E('div', { className: 'sr-brand' }, SR_TITLE),
                E('div', { className: 'sr-sub' }, '查原文、白话；查穴名还带穴位图'))),
            E('div', { className: 'sr-bar' },
              E('input', {
                className: 'sr-input',
                placeholder: '输入要查的字，如「便秘」「少阴病」「足三里」',
                value: q,
                onChange: function (e) { setQ(e.target.value); },
                onKeyDown: function (e) { if (e.key === 'Enter') run(); },
              }),
              E('button', { className: 'sr-btn', onClick: run, disabled: busy }, busy ? '查着…' : '查询')),
            err ? E('div', { className: 'sr-err' }, err) : null,
            note ? E('div', { className: 'sr-err', style: { color: 'inherit', opacity: 0.7 } }, note) : null,
            E('div', { className: 'sr-list' },
              busy
                ? E('div', { className: 'sr-hint' }, '正在查，稍等…')
                : res.length === 0
                  ? E('div', { className: 'sr-hint' }, '还没有结果。输入两个字以上再点查询。')
                  : res.map(card)));
        }
    
        function srRegister(ctx) {
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: SR_PANEL }, SrPanel);
          });
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register({
              name: 'sidebar.panellist',
              id: SR_PANEL,
              order: 23,
              label: function () { return '资料查询'; },
            }, SrIcon);
          });
        }


// ═══ 模拟问诊（客户端）═══════════════════════════════════════════════════
// 下面这一整段只服务「模拟问诊」：面板、图标、入口注册、左栏隐藏。
// 学习版那一边（工作台、资料查询、设置卡片）一个字都不碰它，删掉这一段学习版照用。
// ═════════════════════════════════════════════════════════════════════════

var SIM_PANEL = 'xueli-sim';
var SIM_CHAT_SLOT = 'xueli.sim.chat';
var SIM_TITLE = '模拟问诊';
var SIM_LEVELS = ['简单', '普通', '困难'];
var SIM_TREATS = ['方药', '针灸', '针药'];

function simCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('sim-style')) return;
  var style = document.createElement('style');
  style.id = 'sim-style';
  style.setAttribute('data-plugin', NS);
  style.textContent = [
    '.sim-wrap{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px}',
    '.sim-stage{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;align-items:center;padding:11vh 22px 12px;text-align:center}',
    '.sim-title{font-size:21px;font-weight:600;letter-spacing:1.5px;margin-bottom:9px}',
    '.sim-sub{font-size:12.5px;line-height:1.95;opacity:.62;max-width:560px;margin:0 auto 22px}',
    '.sim-row{display:flex;align-items:center;justify-content:center;gap:7px;margin-bottom:9px}',
    '.sim-label{font-size:12px;opacity:.6;flex:none}',
    '.sim-chip{border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;border-radius:6px;padding:3px 12px;font-size:12px;cursor:pointer}',
    '.sim-chip.on{border-color:#3b6ef5;background:#3b6ef5;color:#fff}',
    '.sim-go{border:1px solid #3b6ef5;background:#3b6ef5;color:#fff;border-radius:8px;padding:7px 26px;font-size:13.5px;cursor:pointer;margin-top:10px}',
    '.sim-go:disabled{opacity:.6;cursor:default}',
    '.sim-full{display:flex;flex-direction:column;height:100%;min-height:0;padding:10px 12px;gap:8px}',
    '.sim-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap}',
    '.sim-badge{font-size:11.5px;opacity:.65;border:1px solid rgba(127,127,127,.25);border-radius:5px;padding:1px 7px}',
    '.sim-mini{border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}',
    '.sim-mini:disabled{opacity:.55;cursor:default}',
    '.sim-body{flex:1 1 auto;height:calc(100vh - 196px);min-height:360px;display:flex;flex-direction:column;overflow:hidden}',
    '.sim-body>*{flex:1;min-height:0}',
    '.sim-chat{flex:1;min-height:0;display:flex;flex-direction:column}',
    '.sim-hint{font-size:12px;opacity:.62;line-height:18px}',
    '.sim-err{font-size:12px;color:#d9534f;line-height:18px;padding:6px 0}',
    '.sim-msg{display:flex}',
    '.sim-msg.me{justify-content:flex-end}',
    '.sim-msg-body{max-width:82%;white-space:pre-wrap;word-break:break-word;border-radius:10px;padding:8px 12px;line-height:1.75;font-size:13.5px}',
    '.sim-msg.them .sim-msg-body{background:rgba(127,127,127,.12)}',
    '.sim-msg.me .sim-msg-body{background:#3b6ef5;color:#fff}',
    // 点评完收局：整个输入区（输入框＋发送＋附件）点不动，只能看和重开。
    '.sim-locked [data-composer-seat]{pointer-events:none;opacity:.55}',
  ].join('');
  document.head.appendChild(style);
}

function simReason(error) {
  return error && error.message ? error.message : String(error || '未知错误');
}

function simRoundId() {
  var d = new Date();
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/** 往一局会话里发一句话：先 retain，等 ready，再 prompt。 */
function simSend(id, text) {
  var svc = wbSessions();
  if (!svc || typeof svc.using !== 'function') return Promise.reject(new Error('会话服务不可用'));
  return Promise.resolve(svc.using(id, { source: 'tcmXueliSim' }, function (ref) {
    return Promise.resolve(ref.ready).then(function (bound) {
      var session = bound && bound.session;
      if (!session || typeof session.prompt !== 'function') throw new Error('这一局还没准备好');
      return wbTimeout(session.prompt([{ type: 'text', text: String(text) }], 'queue'), 20000, '发开局指令')
        .then(function (result) {
          if (result && result.ok === false) {
            throw new Error((result.error && result.error.message) || '这一局没收下这句话');
          }
        });
    });
  }));
}

function SimPanel(props) {
  var levelState = useState('普通');
  var level = levelState[0];
  var setLevel = levelState[1];
  var treatState = useState('针药');
  var treat = treatState[0];
  var setTreat = treatState[1];
  var idState = useState(null);
  var sessionId = idState[0];
  var setSessionId = idState[1];
  var roundState = useState('');
  var round = roundState[0];
  var setRound = roundState[1];
  var busyState = useState(false);
  var busy = busyState[0];
  var setBusy = busyState[1];
  var errState = useState('');
  var err = errState[0];
  var setErr = errState[1];
  // 去会话页只是去看，不能顺手把这一局收走（收走就成了只读）。
  var keepRef = React.useRef(false);
  // 显式收局豁免：restartRound/backToForm 已当场归档，换局触发的 cleanup 别再收第二遍。
  var skipRef = React.useRef(false);
  // 点评说完这一局就被归档（只读）。面板里得跟着锁死：输入区盖住、横幅换成「重开一局」，
  // 否则人还会对着输入框打字，发不出去又不知道为什么。
  var finState = useState(false);
  var finished = finState[0];
  var setFinished = finState[1];
  useEffect(function () {
    var read = function () {
      var ws = Ctx && Ctx.workspaces;
      var snap = ws && ws.list && typeof ws.list.getSnapshot === 'function' ? ws.list.getSnapshot() : null;
      var list = (snap && snap.archivedSessionIds) || [];
      setFinished(Boolean(sessionId) && list.indexOf(sessionId) >= 0);
    };
    read();
    var ws = Ctx && Ctx.workspaces;
    if (ws && ws.list && typeof ws.list.subscribe === 'function') return ws.list.subscribe(read);
    return undefined;
  }, [sessionId]);

  useEffect(function () { simCss(); wbCss(); }, []);

  // 面板一关（返回、换难度、关掉页面）就把这一局收走：DSH 没有删会话的接口，
  // 收走＝归档，左栏和面板里都不再出现，不用医生自己收拾。
  // 切去会话页那一次不算收工，keepRef 拦下来；显式收过的局由 skipRef 拦，不双份归档。
  useEffect(function () {
    if (!sessionId) return undefined;
    var mine = sessionId;
    return function () {
      if (keepRef.current) { keepRef.current = false; return; }
      if (takeSkipFlag(skipRef)) return;
      archiveCurrent(mine);
    };
  }, [sessionId]);

  // 把这一局在会话列表里起个好认的名字；失败不影响问诊。
  var nameRound = function (id, rid, lv, td) {
    var svc = wbSessions();
    if (!svc || typeof svc.using !== 'function') return;
    try {
      svc.using(id, { source: 'tcmXueliSim' }, function (ref) {
        return Promise.resolve(ref.ready).then(function (bound) {
          var session = bound && bound.session;
          if (session && typeof session.rename === 'function') {
            return session.rename('问诊·局 ' + rid + '（' + lv + '·' + td + '）');
          }
          return null;
        });
      }).catch(function () { /* 改不动名也不影响开局 */ });
    } catch (error) { /* 同上 */ }
  };

  var openRound = function (lv, td) {
    if (busy) return;
    var svc = wbSessions();
    if (!svc || typeof svc.create !== 'function') {
      setErr('会话服务不可用：从托盘完全退出 DSH 再启动一次。');
      return;
    }
    setBusy(true);
    setErr('');
    var rid = simRoundId();
    var text = '【模拟问诊 · 开局】' + lv + '｜' + td + '｜' + rid;
    var madeId = null;
    // 只按本预设建：预设建失败就明报，不静默回落默认预设（回落会丢中医人设/遮罩/档位，日后还删不掉）。
    wbTimeout(Promise.resolve(svc.create({ agentPreset: WB_PRESET })), 20000, '建会话')
      .then(function (made) {
        var id = typeof made === 'string' ? made : made && made.id;
        if (!id) throw new Error('没拿到会话 id');
        madeId = id;
        simHideAdd(simRoundIds, id);
        nameRound(id, rid, lv, td);
        return simSend(id, text).then(function () { return id; });
      })
      .then(function (id) {
        setSessionId(id);
        setRound(rid);
        setBusy(false);
      })
      .catch(function (error) {
        setBusy(false);
        // 开局没成，豁免标记作废：当前这一局还在，退出时照常收。
        skipRef.current = false;
        var msg = simReason(error);
        if (madeId) {
          // 会话已建但开局失败（常见是发指令超时）：指令可能仍在排队，客户端只是放弃等待。
          // 把这一局回收掉，别留一个三处列表都看不见的幽灵局。
          delete simRoundIds[madeId];
          archiveCurrent(madeId);
          setErr('开局失败：' + msg + '。' + (msg.indexOf('超时') >= 0 ? '指令可能仍在排队，已回收该局，请重试。' : '已回收该局，请重试。'));
          return;
        }
        setErr('中医预设未就绪，请确认插件已启用后重试。（' + msg + '）');
      });
  };

  // 换局/换难度：旧局归档收起来，别越堆越多。
  // 归档前先告诉插件「这一局不做了」：把它压低的思考档位当场还回去，别留在会话里。
  // 通知失败也不拦着归档——重启后插件还会照档位存根兜底还一次。
  // stopActivity：弃局时这一局可能还在跑（病人还没答完），连活一起停掉再收。
  // purge=1：宿主没有「删会话」的接口，插件自己把它从磁盘上删（不是只归档）。
  var archiveCurrent = function (only) {
    var old = only || sessionId;
    if (!old) return;
    try {
      fetch('/dsh-tcm-xueli/sim-end?purge=1&session=' + encodeURIComponent(old)).catch(function () { /* 通知不到靠存根兜底 */ });
    } catch (error) { /* 同上 */ }
    try {
      if (!Ctx || !Ctx.uiWorkspace || typeof Ctx.uiWorkspace.archiveSession !== 'function') return;
      Promise.resolve(Ctx.uiWorkspace.archiveSession(old, { stopActivity: true })).catch(function () { /* 归档失败也不拦着开新局 */ });
    } catch (error) { /* 同上 */ }
  };

  var start = function () { openRound(level, treat); };

  // 聊天页里的「同设置再来一局」：先把当前这一局收起来，再开新局。
  var restartRound = function () {
    if (busy) return;
    archiveCurrent();
    // 已显式收局：新局建成触发 cleanup 时豁免一次，别把同一局归档两遍。
    skipRef.current = true;
    openRound(level, treat);
  };

  var backToForm = function () {
    if (busy) return;
    archiveCurrent();
    // 同上：显式收过了，setSessionId(null) 触发的 cleanup 不再重复收。
    skipRef.current = true;
    setSessionId(null);
    setRound('');
    setErr('');
  };

  var goChat = function () {
    if (!sessionId) return;
    keepRef.current = true;
    try {
      Ctx.uiWorkspace.openSession(sessionId);
    } catch (error) {
      keepRef.current = false;
      return; // 打不开就留在面板里，这一局照旧藏着
    }
    // 真打开了才把这一局还给官方左栏：移出隐藏集合、记豁免、刷新隐藏样式。
    // 不然面板一卸载 sessionId 就丢，这一局被左栏隐藏样式藏、被工作台按标题排除，
    // 三处入口都找不到它；局本身继续跑，不受影响。
    simHideRelease(simRoundIds, simShownIds, sessionId);
    hideSimRows();
    try { Ctx.layout.selectPanel(null); } catch (error) { /* 面板没关成也不影响这一局可见 */ }
  };

  var chips = function (list, now, pick) {
    return list.map(function (one) {
      return E('button', {
        key: one,
        className: 'sim-chip' + (one === now ? ' on' : ''),
        onClick: function () { pick(one); },
      }, one);
    });
  };

  // 开局之后：整页交给诊室，聊天拉满，输入框才不会被挤掉。
  // 点评完（这一局被归档）：输入区锁住、横幅换成「只能重开局」，去会话页也收起来——
  // 那边输入框锁不到，去了也是白打字（宿主会拦）。
  if (sessionId) {
    return E('div', { className: 'sim-full' },
      E('div', { className: 'sim-bar' },
        E('span', { className: 'sim-badge' }, level + ' · ' + treat),
        E('span', { className: 'sim-badge' }, '局号 ' + (round || '—')),
        E('button', { className: 'sim-mini', onClick: backToForm, disabled: busy }, '换难度重开'),
        E('button', { className: 'sim-mini', onClick: restartRound, disabled: busy }, busy ? '正在开局…' : '同设置再来一局'),
        finished ? null : E('button', { className: 'sim-mini', onClick: goChat }, '去会话页')),
      err ? E('div', { className: 'sim-err' }, err) : null,
      E('div', { className: 'sim-body' + (finished ? ' sim-locked' : '') },
        E(WbChatPane, {
          sessionId: sessionId,
          chatSlot: SIM_CHAT_SLOT,
          renderSlot: props.renderSlot,
          renderFactorySlot: props.renderFactorySlot,
          SessionProvider: props.SessionProvider,
          archivedText: finished ? '这一局已结束，不能再输入了。要再练一局，点「重开一局」。' : undefined,
          archivedActionLabel: finished ? '重开一局' : undefined,
          onArchivedAction: finished ? restartRound : undefined,
        })));
  }

  return E('div', { className: 'sim-wrap' },
    E('div', { className: 'sim-stage' },
      E('div', { className: 'sim-title' }, '模拟问诊室'),
      E('div', { className: 'sim-sub' }, '欢迎使用经方学习版。选好难度和方向，点「开始一局」就能开诊：病人（子模型）在诊室里先开口，你扮医生一问一答。说「交卷」，裁判当场逐条指正。'),
      E('div', { className: 'sim-row' },
        E('span', { className: 'sim-label' }, '难度'),
        chips(SIM_LEVELS, level, setLevel)),
      E('div', { className: 'sim-row' },
        E('span', { className: 'sim-label' }, '方向'),
        chips(SIM_TREATS, treat, setTreat)),
      E('button', { className: 'sim-go', onClick: start, disabled: busy }, busy ? '正在开局…' : '开始一局'),
      err ? E('div', { className: 'sim-err' }, err) : null),
    E('div', { className: 'sim-hint', style: { padding: '10px 14px 12px', flex: 'none', borderTop: '1px solid rgba(127,127,127,.14)', textAlign: 'center' } },
      '开局之后这里就是诊室。交卷时裁判按内经难经、仲景法度、脉经、甲乙经逐条指正，只给过关／边缘／不过关，不给剂量。点评说完这一局就锁上了，不能再问；关掉这个面板或开下一局时，这一局连同记录一起收走。'));
}
function SimIcon() {
  return E('svg', {
    width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
  },
    E('rect', { x: 2.6, y: 2.6, width: 14.8, height: 14.8, rx: 3.6, stroke: 'currentColor', strokeWidth: 1.35 }),
    E('text', {
      x: 10, y: 14.3, textAnchor: 'middle', fontSize: 10.4,
      fill: 'currentColor', fontFamily: 'inherit',
    }, '诊'));
}

function simRegister(ctx) {
  var decl = {};
  decl[SIM_CHAT_SLOT] = { kind: 'single', scope: 'session' };
  ctx.slots.inject('main', function () {
    return ctx.slots.register({ name: 'main', key: SIM_PANEL, children: decl }, SimPanel);
  });
  ctx.slots.inject(SIM_CHAT_SLOT, function () {
    return ctx.slots.register({ name: SIM_CHAT_SLOT }, WbChatSlot);
  });
  ctx.slots.inject('sidebar.panellist', function () {
    return ctx.slots.register({
      name: 'sidebar.panellist',
      id: SIM_PANEL,
      order: 24,
      label: function () { return '模拟问诊'; },
    }, SimIcon);
  });
  // 入口都挂上了再开左栏隐藏：注册半路失败就别留个定时器在后台改 DOM。
  startHideSimRows();
}

    // ═══ 讲解答疑（客户端）═══════════════════════════════════════════════════
    // >>> TEACH-BEGIN 讲解答疑模块 >>> 这一段自成一块：改插件别的部分不许碰它；
    // 真要改这里，改完必须同步 verify-preset.mjs 里的 TEACH_LOCK 指纹，否则自检报红。
// 一整块「问一句话、老师按四段讲清」的答疑面板：开一问，把开场话发进新会话，
// 聊天交给官方窗口画。答疑的局不归档、不删除，留在工作台历史里，改天还翻得回来。
// ═════════════════════════════════════════════════════════════════════════

var TE_PANEL = 'xueli-teach';
var TE_CHAT_SLOT = 'xueli.teach.chat';
var TE_TITLE = '讲解答疑';
var TE_SAMPLES = [
  '桂枝汤证和麻黄汤证差在哪？靠哪一项分？',
  '「阳化气，阴成形」这一句怎么讲？',
  '脉浮缓、按之无力，是不是就能断成表虚？',
  '黄连和黄芩都苦寒，主治差在哪？',
];

function teCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('te-style')) return;
  var style = document.createElement('style');
  style.id = 'te-style';
  style.setAttribute('data-plugin', NS);
  style.textContent = [
    '.te-wrap{display:flex;flex-direction:column;height:100%;min-height:0;padding:18px 20px;gap:10px;font-size:13px;overflow:auto}',
    '.te-head{display:flex;align-items:center;gap:12px;flex:none}',
    '.te-head-text{min-width:0}',
    '.te-avatar{flex:none;display:block;width:64px;height:64px;border-radius:50%;object-fit:cover;background:#f8f3ea;box-shadow:0 0 0 1px rgba(140,120,90,.35)}',
    '.te-title{font-size:15px;font-weight:600}',
    '.te-byline{font-size:11.5px;opacity:.6;margin-top:3px;line-height:16px}',
    '.te-sub{font-size:12px;opacity:.66;line-height:19px}',
    '.te-area{width:100%;min-height:86px;resize:vertical;border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:9px 11px;font-size:13px;line-height:1.7;background:transparent;color:inherit;outline:none;font-family:inherit;box-sizing:border-box}',
    '.te-go{align-self:flex-start;border:1px solid #3b6ef5;background:#3b6ef5;color:#fff;border-radius:7px;padding:6px 16px;font-size:13px;cursor:pointer}',
    '.te-go:disabled{opacity:.55;cursor:default}',
    '.te-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.te-chip{border:1px solid rgba(127,127,127,.28);background:transparent;color:inherit;border-radius:14px;padding:4px 11px;font-size:12px;cursor:pointer;text-align:left;line-height:1.5;max-width:100%}',
    '.te-chip:hover{background:rgba(127,127,127,.1)}',
    '.te-err{color:#d9534f;font-size:12px;line-height:18px}',
    '.te-hint{font-size:11.5px;opacity:.55;line-height:18px}',
    '.te-hist{display:flex;flex-direction:column;gap:4px;border-top:1px solid rgba(127,127,127,.16);padding-top:9px;margin-top:2px;min-height:0}',
    '.te-hist-head{font-size:12px;opacity:.66;flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.te-hlink{border:0;background:transparent;color:inherit;font-size:11.5px;opacity:.75;cursor:pointer;padding:0;text-decoration:underline}',
    '.te-herr{color:#d9534f;font-size:11.5px;line-height:17px}',
    '.te-hlist{display:flex;flex-direction:column;gap:2px;max-height:190px;overflow:auto}',
    '.te-hrow{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;font-size:12.5px;line-height:18px;width:100%;box-sizing:border-box}',
    '.te-hrow:hover{background:rgba(127,127,127,.12)}',
    '.te-hrow.on{background:rgba(127,127,127,.1);flex-wrap:wrap}',
    '.te-hrow.gone{opacity:.6}',
    '.te-hopen{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;border:0;background:transparent;color:inherit;text-align:left;padding:2px 0;cursor:pointer;font:inherit}',
    '.te-hops{flex:none;display:flex;gap:4px;opacity:0;transition:opacity .12s}',
    '.te-hrow:hover .te-hops,.te-hrow.on .te-hops,.te-hrow:focus-within .te-hops{opacity:1}',
    '.te-hmini{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:5px;padding:1px 6px;font-size:11px;cursor:pointer;line-height:16px;flex:none}',
    '.te-hmini:hover{background:rgba(127,127,127,.14)}',
    '.te-hmini.danger{color:#d9534f;border-color:rgba(217,83,79,.45)}',
    '.te-hin{flex:1;min-width:0;border:1px solid rgba(127,127,127,.35);border-radius:5px;padding:2px 7px;font-size:12.5px;background:transparent;color:inherit;outline:none;font-family:inherit}',
    '.te-hnote{flex:1 0 100%;font-size:11px;opacity:.55;line-height:17px}',
    '.te-htitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.te-hmeta{flex:none;font-size:11px;opacity:.45}',
    '.te-hempty{font-size:11.5px;opacity:.5;line-height:18px;padding:2px 0 4px}',
    '.te-full{display:flex;flex-direction:column;height:100%;min-height:0}',
    '.te-bar{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid rgba(127,127,127,.18);flex:none;font-size:12px}',
    '.te-quote{flex:1;min-width:0;opacity:.8;word-break:break-word;line-height:1.6}',
    '.te-mini{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;line-height:17px;flex:none}',
    '.te-mini:hover{background:rgba(127,127,127,.12)}',
    '.te-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  ].join('');
  document.head.appendChild(style);
}

/** 会话名字存完整问题（带「答疑·」前缀）：续讲顶部要显示全文。
 *  列表里靠 CSS 省略号截断显示，不在这里截——截了续讲就只剩前 14 字。 */
function teTitle(text) {
  var one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '答疑';
  return '答疑·' + one;
}

/** 答疑自己的历史：只挑名字以「答疑·」开头的那些局，跟工作台那份分开摆。
 *  局限（如实说明）：认局靠标题前缀。核对过宿主 API（packages/api/session-controller
 *  的 ISessions）：create 只收 workspaceId/cwd/sessionId/agentPreset，没有插件可写的元数据；
 *  projectionValues 是宿主算的投影，注册自定义投影要动宿主侧，超出本次 client-only 修复范围。
 *  所以在官方会话页改名丢了前缀，这一问就从本历史消失（会话本身还在，预设仍是本插件）。 */
function teScan() {
  var svc = wbSessions();
  if (!svc || !svc.list || typeof svc.list.getSnapshot !== 'function') return null;
  var snap = svc.list.getSnapshot();
  var ids = (snap && snap.ids) || [];
  var ws = Ctx && Ctx.workspaces;
  var wsnap = ws && ws.list && typeof ws.list.getSnapshot === 'function' ? ws.list.getSnapshot() : null;
  var archivedIds = (wsnap && wsnap.archivedSessionIds) || [];
  var arch = {};
  for (var a = 0; a < archivedIds.length; a += 1) arch[archivedIds[a]] = true;
  var out = [];
  for (var i = 0; i < ids.length; i += 1) {
    var row = snap.byId ? snap.byId[ids[i]] : null;
    if (!row || row.parentId || row.origin === 'subagent' || row.blank) continue;
    var preset = row.projectionValues && row.projectionValues.agentPreset;
    if (preset !== WB_PRESET) continue;
    var title = String(row.title || row.displayTitle || '');
    if (title.indexOf('答疑·') !== 0) continue;
    out.push({ id: ids[i], title: title, at: row.updatedAt || 0, archived: !!arch[ids[i]] });
  }
  out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  return out;
}

/** 历史里那一行的时间：只写月日时分，认不出就不写。 */
function teWhen(at) {
  var n = Number(at);
  if (!n) return '';
  var d = new Date(n);
  if (isNaN(d.getTime())) return '';
  var pad = function (v) { return (v < 10 ? '0' : '') + v; };
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function TeaPanel(props) {
  var qState = useState('');
  var q = qState[0];
  var setQ = qState[1];
  var idState = useState(null);
  var sessionId = idState[0];
  var setSessionId = idState[1];
  var askState = useState('');
  var asked = askState[0];
  var setAsked = askState[1];
  var busyState = useState(false);
  var busy = busyState[0];
  var setBusy = busyState[1];
  var errState = useState('');
  var err = errState[0];
  var setErr = errState[1];
  var histState = useState([]);
  var hist = histState[0];
  var setHist = histState[1];
  var editState = useState(null);
  var edit = editState[0];
  var setEdit = editState[1];
  var archState = useState(false);
  var showArch = archState[0];
  var setShowArch = archState[1];
  var hErrState = useState('');
  var hErr = hErrState[0];
  var setHErr = hErrState[1];

  // 列表重新拉一遍：订着宿主的会话列表，改完名、归档、删掉都靠它刷新。
  var loadHist = function () {
    var got = teScan();
    if (got) setHist(got);
  };

  useEffect(function () {
    teCss();
    wbCss();
    loadHist();
    var svc = wbSessions();
    var stops = [];
    if (svc && svc.list && typeof svc.list.subscribe === 'function') {
      try { stops.push(svc.list.subscribe(loadHist)); } catch (error) { /* 订不上就只在进门时扫一次 */ }
    }
    return function () {
      for (var i = 0; i < stops.length; i += 1) { try { stops[i](); } catch (error) { /* 已退订 */ } }
    };
  }, []);

  var nameAsk = function (id, text) {
    var svc = wbSessions();
    if (!svc || typeof svc.using !== 'function') return;
    try {
      svc.using(id, { source: 'tcmXueliTeach' }, function (ref) {
        return Promise.resolve(ref.ready).then(function (bound) {
          var session = bound && bound.session;
          if (session && typeof session.rename === 'function') return session.rename(teTitle(text));
          return null;
        });
      }).catch(function () { /* 改不动名也不影响开讲 */ });
    } catch (error) { /* 同上 */ }
  };

  var open = function () {
    if (busy) return;
    var text = String(q || '').trim();
    if (!text) {
      setErr('先把问题写进来：想问哪两样怎么分，或者哪个说法一直想不通。');
      return;
    }
    var svc = wbSessions();
    if (!svc || typeof svc.create !== 'function') {
      setErr('会话服务不可用：从托盘完全退出 DSH 再启动一次。');
      return;
    }
    setBusy(true);
    setErr('');
    var madeId = null;
    // 只按本预设建：预设建失败就明报，不静默回落默认预设（回落会丢中医人设/遮罩/档位，日后还删不掉）。
    wbTimeout(Promise.resolve(svc.create({ agentPreset: WB_PRESET })), 20000, '建会话')
      .then(function (made) {
        var id = typeof made === 'string' ? made : made && made.id;
        if (!id) throw new Error('没拿到会话 id');
        madeId = id;
        nameAsk(id, text);
        return simSend(id, '【讲解答疑 · 开讲】\n' + text).then(function () { return id; });
      })
      .then(function (id) {
        setSessionId(id);
        setAsked(text);
        setBusy(false);
      })
      .catch(function (error) {
        setBusy(false);
        var msg = simReason(error);
        if (madeId) {
          // 会话已建但开讲失败（常见是发指令超时）：指令可能仍在排队，客户端只是放弃等待。
          // 回收这一局：先走本插件删除通道（服务端按预设认局，改名没完成也认得），
          // 再补一道官方归档停活兜底，别留三处都看不见的幽灵局。
          try {
            fetch('/dsh-tcm-xueli/teach-end?doing=delete&session=' + encodeURIComponent(madeId), {
              credentials: 'same-origin',
            }).catch(function () { /* 通道没应声就靠归档兜底 */ });
          } catch (error) { /* 同上 */ }
          try {
            if (Ctx && Ctx.uiWorkspace && typeof Ctx.uiWorkspace.archiveSession === 'function') {
              Promise.resolve(Ctx.uiWorkspace.archiveSession(madeId, { stopActivity: true })).catch(function () { /* 兜底失败不拦着报错 */ });
            }
          } catch (error) { /* 同上 */ }
          setErr('开讲失败：' + msg + '。' + (msg.indexOf('超时') >= 0 ? '指令可能仍在排队，已回收该局，请重试。' : '已回收该局，请重试。'));
          return;
        }
        setErr('中医预设未就绪，请确认插件已启用后重试。（' + msg + '）');
      });
  };

  var goChat = function () {
    if (!sessionId) return;
    try { Ctx.uiWorkspace.openSession(sessionId); } catch (error) { /* 打不开就留在面板里 */ }
    try { Ctx.layout.selectPanel(null); } catch (error) { /* 同上 */ }
  };

  // 返回提问页不算收工：这一问留在工作台历史里，不归档也不删。
  var backToForm = function () {
    if (busy) return;
    setSessionId(null);
    setAsked('');
    setErr('');
  };

  // 点历史里的一问：接着那一局讲，不新建。
  // 顶部展示完整标题（去掉「答疑·」前缀后不截断）；列表里仍靠 CSS 省略号截断。
  var openOld = function (row) {
    if (busy || !row || !row.id) return;
    setSessionId(row.id);
    setAsked(String(row.title || '').replace(/^答疑·/, ''));
    setErr('');
  };

  /* ── 历史那一栏的三个动作：改名、归档/恢复、删除 ── */

  var doTitle = function (id, text) {
    var next = String(text === undefined ? '' : text).trim();
    setEdit(null);
    setHErr('');
    if (!next) { setHErr('名字不能是空的'); return; }
    var svc = wbSessions();
    if (!svc || typeof svc.using !== 'function') { setHErr('会话服务不支持改名'); return; }
    Promise.resolve(svc.using(id, { source: 'tcmXueliTeach' }, function (ref) {
      return Promise.resolve(ref.ready).then(function (bound) {
        // 名字前面那段「答疑·」是本面板认自己那一局的记号，改名时不能丢。
        return bound.session.rename('答疑·' + next);
      });
    })).then(loadHist).catch(function (error) { setHErr('改名失败：' + wbReason(error)); });
  };

  var doArchive = function (id) {
    setEdit(null);
    setHErr('');
    if (!Ctx || !Ctx.uiWorkspace || typeof Ctx.uiWorkspace.archiveSession !== 'function') {
      setHErr('会话服务不支持归档');
      return;
    }
    Promise.resolve(Ctx.uiWorkspace.archiveSession(id, { stopActivity: true }))
      .then(function () {
        if (sessionId === id) backToForm();
        loadHist();
      })
      .catch(function (error) { setHErr('归档失败：' + wbReason(error)); });
  };

  var doRestore = function (id) {
    setHErr('');
    if (!Ctx || !Ctx.uiWorkspace || typeof Ctx.uiWorkspace.unarchiveSession !== 'function') {
      setHErr('会话服务不支持恢复');
      return;
    }
    Promise.resolve(Ctx.uiWorkspace.unarchiveSession(id))
      .then(loadHist)
      .catch(function (error) { setHErr('恢复失败：' + wbReason(error)); });
  };

  // 真删：宿主没有删会话的接口，走插件自己的通道（只认标题以「答疑·」开头的本机局）。
  var doDelete = function (id) {
    setEdit(null);
    setHErr('');
    Promise.resolve(fetch('/dsh-tcm-xueli/teach-end?doing=delete&session=' + encodeURIComponent(id), {
      credentials: 'same-origin',
    })).then(function (res) { return res.json(); })
      .then(function (got) {
        if (!got || !got.ok) {
          setHErr('没删掉：' + String((got && got.reason) || '通道没应声'));
          return;
        }
        if (sessionId === id) backToForm();
        loadHist();
      })
      .catch(function (error) { setHErr('删除失败：' + String((error && error.message) || error)); });
  };

  var hRow = function (row) {
    var name = String(row.title || '').replace(/^答疑·/, '');
    if (edit && edit.id === row.id && edit.kind === 'rename') {
      return E('div', { key: row.id, className: 'te-hrow on' },
        E('input', {
          className: 'te-hin',
          autoFocus: true,
          value: edit.text,
          onChange: function (event) { setEdit({ id: row.id, kind: 'rename', text: event.target.value }); },
          onKeyDown: function (event) {
            if (event.key === 'Enter') doTitle(row.id, edit.text);
            if (event.key === 'Escape') setEdit(null);
          },
        }),
        E('div', { className: 'te-hops' },
          E('button', { className: 'te-hmini', onClick: function () { doTitle(row.id, edit.text); } }, '保存'),
          E('button', { className: 'te-hmini', onClick: function () { setEdit(null); } }, '取消')));
    }
    if (edit && edit.id === row.id && edit.kind === 'delete') {
      return E('div', { key: row.id, className: 'te-hrow on' },
        E('div', { className: 'te-htitle' }, '删掉「' + (name || '这一问') + '」？'),
        E('div', { className: 'te-hnote' }, '删了就找不回来。只是不想让它留在列表里，点「归档」更稳妥。'),
        E('div', { className: 'te-hops' },
          E('button', { className: 'te-hmini danger', onClick: function () { doDelete(row.id); } }, '确定删除'),
          E('button', { className: 'te-hmini', onClick: function () { setEdit(null); } }, '取消')));
    }
    return E('div', {
      key: row.id,
      className: 'te-hrow' + (row.archived ? ' gone' : ''),
      title: name,
    },
      E('button', {
        className: 'te-hopen',
        onClick: function () { openOld(row); },
      },
        E('span', { className: 'te-htitle' }, name || '（这一问）'),
        E('span', { className: 'te-hmeta' }, teWhen(row.at), row.archived ? ' · 已归档' : '')),
      E('div', { className: 'te-hops' },
        E('button', { className: 'te-hmini', onClick: function () { setEdit({ id: row.id, kind: 'rename', text: name }); } }, '改名'),
        row.archived
          ? E('button', { className: 'te-hmini', onClick: function () { doRestore(row.id); } }, '恢复')
          : E('button', { className: 'te-hmini', onClick: function () { doArchive(row.id); } }, '归档'),
        E('button', { className: 'te-hmini danger', onClick: function () { setEdit({ id: row.id, kind: 'delete' }); } }, '删除')));
  };

  var chips = function () {
    return TE_SAMPLES.map(function (one) {
      return E('button', {
        key: one,
        className: 'te-chip',
        onClick: function () { setQ(one); setErr(''); },
      }, one);
    });
  };

  // 开讲之后：整页交给老师，聊天拉满，输入框才不会被挤掉。
  if (sessionId) {
    return E('div', { className: 'te-full' },
      E('div', { className: 'te-bar' },
        E('span', { className: 'te-quote' }, '本问 · ' + (asked || '')),
        E('button', { className: 'te-mini', onClick: backToForm, disabled: busy }, '换个问题'),
        E('button', { className: 'te-mini', onClick: goChat }, '去会话页')),
      E('div', { className: 'te-body' },
        E(WbChatPane, {
          sessionId: sessionId,
          chatSlot: TE_CHAT_SLOT,
          renderSlot: props.renderSlot,
          renderFactorySlot: props.renderFactorySlot,
          SessionProvider: props.SessionProvider,
        })));
  }

  var histShown = hist.filter(function (row) { return showArch ? true : !row.archived; });
  var archCount = hist.filter(function (row) { return !!row.archived; }).length;

  return E('div', { className: 'te-wrap' },
    E('div', { className: 'te-head' },
      E(TeAvatar, { size: 64 }),
      E('div', { className: 'te-head-text' },
        E('div', { className: 'te-title' }, TE_TITLE),
        E('div', { className: 'te-byline' }, '问一句，老先生按四段讲清'))),
    E('div', { className: 'te-sub' }, '问一个问题，老师按四段讲：先给结论，再说靠哪一项分、依据在哪；接着讲这个结论在什么情况下不成立，最后说清还缺什么才定得下来。不摆十项问诊，也不给剂量。'),
    E('textarea', {
      className: 'te-area',
      value: q,
      placeholder: '例：桂枝汤证和麻黄汤证差在哪？条文、脉象、药性、针灸也都能问',
      onChange: function (event) { setQ(event && event.target ? event.target.value : ''); },
    }),
    err ? E('div', { className: 'te-err' }, err) : null,
    E('button', { className: 'te-go', onClick: open, disabled: busy }, busy ? '正在开讲…' : '开始讲'),
    E('div', { className: 'te-sub' }, '想不出问什么，先点一个：'),
    E('div', { className: 'te-chips' }, chips()),
    E('div', { className: 'te-hist' },
      E('div', { className: 'te-hist-head' },
        E('span', {}, '问过的（点一条接着问）'),
        archCount || showArch
          ? E('button', {
            className: 'te-hlink',
            onClick: function () { setShowArch(!showArch); },
          }, showArch ? '收起已归档' : '显示已归档（' + archCount + '）')
          : null),
      hErr ? E('div', { className: 'te-herr' }, hErr) : null,
      histShown.length
        ? E('div', { className: 'te-hlist' }, histShown.map(hRow))
        : E('div', { className: 'te-hempty' }, '还没问过。问完一句就留在这儿，下次点开接着问。')),
    E('div', { className: 'te-hint' },
      '讲方只到方名、每味药在方里的分工和加减方向；讲穴只到穴名、主配分工与依据；讲药只到药性、药味、主治与配伍禁忌；都不给克数、处方笺和针法。问过的留着——在上面「问过的」里，点一条就接着讲，不用重问。'));
}

/** 讲解答疑的小像：一位束发白须的老先生，随包的线描小图（assets/img/laoyi.png）。 */
function TeAvatar(props) {
  var size = (props && props.size) || 64;
  return E('img', {
    className: 'te-avatar', src: '/dsh-tcm-xueli/img/laoyi.png',
    width: size, height: size, alt: '老先生', loading: 'lazy',
  });
}

function TeIcon() {
  return E('svg', {
    width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
  },
    E('rect', { x: 2.6, y: 2.6, width: 14.8, height: 14.8, rx: 3.6, stroke: 'currentColor', strokeWidth: 1.35 }),
    E('text', {
      x: 10, y: 14.3, textAnchor: 'middle', fontSize: 10.4,
      fill: 'currentColor', fontFamily: 'inherit',
    }, '讲'));
}

function teachRegister(ctx) {
  var decl = {};
  decl[TE_CHAT_SLOT] = { kind: 'single', scope: 'session' };
  ctx.slots.inject('main', function () {
    return ctx.slots.register({ name: 'main', key: TE_PANEL, children: decl }, TeaPanel);
  });
  ctx.slots.inject(TE_CHAT_SLOT, function () {
    return ctx.slots.register({ name: TE_CHAT_SLOT }, WbChatSlot);
  });
  ctx.slots.inject('sidebar.panellist', function () {
    return ctx.slots.register({
      name: 'sidebar.panellist',
      id: TE_PANEL,
      order: 25,
      label: function () { return '讲解答疑'; },
    }, TeIcon);
  });
}
    // <<< TEACH-END 讲解答疑模块 <<<

    exports.name = 'dsh-tcm-xueli/client';
    exports.inject = ['slots', 'sessions', 'layout', 'uiWorkspace', 'workspaces'];

    exports.apply = function (ctx) {
      try {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.warn(TAG + ' 缺少 slots 服务，设置卡片不挂载');
          return;
        }
        Ctx = ctx;
        try {
          if (typeof ctx.effect === 'function') {
            ctx.effect(function () { return function () { stopHideSimRows(); removePluginStyles(); }; });
          }
        } catch (error) { /* 老内核没有 effect 就算了 */ }
        try {
          wbRegister(ctx);
        } catch (error) {
          console.warn(TAG + ' 学习版入口挂载失败：', error && error.message ? error.message : error);
        }
        try {
          srRegister(ctx);
        } catch (error) {
          console.warn(TAG + ' 资料查询入口挂载失败：', error && error.message ? error.message : error);
        }
        try {
          simRegister(ctx);
        } catch (error) {
          console.warn(TAG + ' 模拟问诊入口挂载失败：', error && error.message ? error.message : error);
        }
        try {
          teachRegister(ctx);
        } catch (error) {
          console.warn(TAG + ' 讲解答疑入口挂载失败：', error && error.message ? error.message : error);
        }
        ctx.slots.inject('settings.section', function () {
          var form = null;
          try {
            ctx.inject(['configForms'], function (fctx) {
              try {
                var forms = fctx && fctx.configForms;
                if (forms && typeof forms.get === 'function') form = forms.get(NS);
              } catch (error) {
                console.warn(TAG + ' 读取设置表单失败：', error && error.message ? error.message : error);
              }
            });
          } catch (error) {
            console.warn(TAG + ' configForms 接线失败：', error && error.message ? error.message : error);
          }
          return register(ctx, form);
        });
      } catch (error) {
        console.warn(TAG + ' 客户端半加载失败：', error && error.message ? error.message : error);
      }
    };

    // 测试钩子：只供 test/client.test.mjs 对纯函数与隐藏样式做行为断言；宿主运行时不读这个键。
    // 两份集合原地清空（stopHideSimRows 不重新赋值），这里暴露的活引用始终有效。
    exports.__test = {
      simIdSafe: simIdSafe,
      simHideAdd: simHideAdd,
      simHideRelease: simHideRelease,
      simHideExempt: simHideExempt,
      takeSkipFlag: takeSkipFlag,
      hideSimRows: hideSimRows,
      stopHideSimRows: stopHideSimRows,
      removePluginStyles: removePluginStyles,
      simRoundIds: simRoundIds,
      simShownIds: simShownIds,
      // 医案（只读导入）：纯函数与组件身份，供行为测试断言。
      loadYianList: loadYianList,
      persistYianList: persistYianList,
      yianAddToList: yianAddToList,
      YianPane: YianPane,
      YianPicker: YianPicker,
      WbPanel: WbPanel,
      WbChatPane: WbChatPane,
    };

    return module.exports;
  },
});