import { Injectable } from '@angular/core';

export interface IGreeter {
  greet(name: string): string;
}

/** Greets a named visitor. */
@Injectable({ providedIn: 'root' })
export class GreeterService implements IGreeter {
  greet(name: string): string {
    return this.buildMessage(name);
  }

  private buildMessage(name: string): string {
    return `Hello, ${name}!`;
  }
}
