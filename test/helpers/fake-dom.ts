/* The fake page the browser half runs against: one element implementation carrying exactly the primitives the client
 * touches (style custom properties, classList, listeners, insertion, rects), the three page shapes built on it, and the
 * storage/window doubles that stand in for the rest of the browser. The suite imports these, so a component behaves here
 * as it does against the real DOM and the double has one home instead of a three-hundred-line test preamble. */

/** A style object carrying custom properties as the DOM does, plus plain ones (cssText, top, display) the client sets. */
export function fakeStyle() {
  const values = {}
  return {
    setProperty(name, value) {
      values[name] = String(value)
    },
    getPropertyValue(name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ''
    },
    removeProperty(name) {
      delete values[name]
    },
  }
}
/** The element factory pair every page exposes. */
function pageElements() {
  return {
    createElement: (tag) => fakeNode(tag),
    createElementNS: (namespace, tag) => fakeNode(tag),
  }
}
/** The listener bookkeeping a page keeps: an array per type, which `fire` walks. */
function pageListeners() {
  return {
    listeners: {},
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener() {},
  }
}
export function fakeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    children: [],
    listeners: {},
    className: '',
    textContent: '',
    title: '',
    id: '',
    type: '',
    parentNode: null,
    style: fakeStyle(),
    rect: { left: 0, top: 0, width: 280, height: 800, right: 280, bottom: 800 },
    get firstChild() {
      return this.children.length > 0 ? this.children[0] : null
    },
    get nextSibling() {
      if (this.parentNode === null) return null
      const at = this.parentNode.children.indexOf(this)
      return at >= 0 && at + 1 < this.parentNode.children.length ? this.parentNode.children[at + 1] : null
    },
    classList: {
      add(name) {
        const parts = node.className.split(' ').filter((part) => part !== '')
        if (!parts.includes(name)) parts.push(name)
        node.className = parts.join(' ')
      },
      remove(name) {
        node.className = node.className
          .split(' ')
          .filter((part) => part !== '' && part !== name)
          .join(' ')
      },
      contains(name) {
        return node.className.split(' ').includes(name)
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
    appendChild(child) {
      child.parentNode = this
      this.children.push(child)
      return child
    },
    append(...items) {
      for (const item of items) this.appendChild(item)
    },
    insertBefore(child, reference) {
      child.parentNode = this
      const at = reference === null ? this.children.length : this.children.indexOf(reference)
      if (at < 0) this.children.push(child)
      else this.children.splice(at, 0, child)
      return child
    },
    removeChild(child) {
      const at = this.children.indexOf(child)
      if (at >= 0) this.children.splice(at, 1)
      child.parentNode = null
      return child
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this)
    },
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener() {},
    click() {
      for (const handler of this.listeners.click || []) handler({ target: this })
    },
    select() {},
    contains(candidate) {
      let cursor = candidate
      while (cursor) {
        if (cursor === this) return true
        cursor = cursor.parentNode
      }
      return false
    },
    getBoundingClientRect() {
      return this.rect
    },
  }
  return node
}
/** The overlay host's page: a body carriers mount on, and an html element for the caption band. */
export function fakeDocument(options = {}) {
  const body = fakeNode('body')
  const documentElement = fakeNode('html')
  if (typeof options.captionHeight === 'string') documentElement.setAttribute('data-windows-titlebar', '')
  return {
    body,
    documentElement,
    listeners: {},
    ...pageElements(),
    execCommand: options.execCommand,
    addEventListener(type, handler) {
      this.listeners[type] = handler
    },
    removeEventListener(type) {
      delete this.listeners[type]
    },
  }
}
/** The framed page's own document: enough shape for the injected row and file bridge. */
export function fakeFrameDocument(options = {}) {
  const head = fakeNode('head')
  const body = fakeNode('body')
  const root = fakeNode('div')
  root.id = 'root'
  if (options.noRoot !== true) body.appendChild(root)
  return {
    head,
    body,
    baseURI: options.baseURI || 'http://127.0.0.1:1/dsh-remote-go/remote/h_a/',
    documentElement: fakeNode('html'),
    ...pageElements(),
    execCommand: options.execCommand,
    querySelector(selector) {
      if (selector === '#root' || selector === '[data-dsh-root]') return options.noRoot === true ? null : root
      return null
    },
    querySelectorAll: () => [],
    ...pageListeners(),
  }
}
/** A local sidebar: the brand drag row, the tall column, and the region the shell would render into. */
export function fakeDom(options = {}) {
  const width = options.sidebarWidth === undefined ? 280 : options.sidebarWidth
  const head = fakeNode('head')
  const body = fakeNode('body')
  const column = fakeNode('div')
  column.rect = { left: 0, top: 40, width, height: 760, right: width, bottom: 800 }
  body.appendChild(column)
  let brand = null
  if (options.brand !== false) {
    brand = fakeNode('div')
    brand.setAttribute('data-window-drag', 'true')
    brand.rect = { left: 0, top: 40, width, height: 40, right: width, bottom: 80 }
    column.appendChild(brand)
  }
  const region = fakeNode('div')
  region.rect = { left: 0, top: 80, width, height: 700, right: width, bottom: 780 }
  column.appendChild(region)
  const document = {
    head,
    body,
    ...pageElements(),
    ...pageListeners(),
    querySelectorAll(selector) {
      if (selector === '[data-window-drag]') return brand === null ? [] : [brand]
      if (selector === 'div,aside,nav,section') return [column]
      return []
    },
  }
  return { document, column, brand, head }
}
/** Deliver one event of `type` to the node's listeners, as the browser would. */
export function fire(node, type, event) {
  for (const handler of node.listeners[type] || []) handler(event)
}
/** One origin's `localStorage`, shared by two framed pages the way a real same-origin frame is. */
export function fakeStorage() {
  const map = new Map()
  return {
    map,
    get length() {
      return map.size
    },
    key(index) {
      const keys = [...map.keys()]
      return index >= 0 && index < keys.length ? keys[index] : null
    },
    getItem(key) {
      const name = String(key)
      return map.has(name) ? map.get(name) : null
    },
    setItem(key, value) {
      map.set(String(key), String(value))
    },
    removeItem(key) {
      map.delete(String(key))
    },
  }
}
/** A guest window with a recording `addEventListener`, for the storage partition. */
export function fakeGuestWindow(storage) {
  return { localStorage: storage, ...pageListeners() }
}
