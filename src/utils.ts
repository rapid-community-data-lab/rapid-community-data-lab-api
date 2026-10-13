export class PromiseQueue {
  concurrency: number;
  sharedFunction: Function;
  queue = [];
  #returnSlot;
  constructor(concurrency = 1, sharedFunction?: Function) {
    this.concurrency = concurrency;
    this.sharedFunction = sharedFunction;
    this.queue = new Array(concurrency);
  }
  /**
   * Enqueue a value or function to be run. This method will be awaited until there is an available slot in the queue. 
   */
  //async enqueue<V>(value: V): Promise<R>;
  //async enqueue<RV, V extends () => Promise<RV>>(task: V): Promise<RV>;
  async enqueue(valueOrTask) {
    let slot = this.queue.findIndex(v => v == null);
    if (slot === -1) {
      slot = await (new Promise(resolve => {
        this.#returnSlot = resolve;
      }));
    }
    let p: Promise<any>;
    if (typeof valueOrTask === 'function') {
      p = valueOrTask();
    } else {
      if (!this.sharedFunction) throw new Error('No shared function provided for non-function tasks');
      p = this.sharedFunction(valueOrTask);
    }
    const release = () => {
      this.queue[slot] = null;
      this.#returnSlot?.(slot);
    };
    this.queue[slot] = p.then(
      v => {
        release();
        return v;
      },
      e => {
        release();
        return e;
      },
    );
    return { value: p };
  }
  async done() {
    await Promise.allSettled(this.queue);
  }
}

export function firstStringOrId(values: unknown[]): string | undefined {
  for (const value of values || []) {
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'object' && value !== null && '@id' in value && typeof value['@id'] === 'string') {
      return value['@id'];
    }
  //return typeof value === 'string' ? value : (value as { '@id'?: string })?.['@id'];
  }
}

// function delay() {
//   return new Promise(resolve => setTimeout(resolve, 200));
// }
// const pq = new PromiseQueue(4);
// for (let i=0; i<10; i++) {
//   console.log('s', i);
//   await pq.enqueue(async () => {
//     await delay();
//     console.log(i);
//   });
// }