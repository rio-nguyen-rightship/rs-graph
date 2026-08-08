import { RouterConfiguration, Router } from 'aurelia-router';

export class App {
  router!: Router;
  message = 'Hello Aurelia';

  configureRouter(config: RouterConfiguration, router: Router): void {
    config.map([
      { route: '', name: 'home', moduleId: './home', title: 'Home' },
      { route: 'about', name: 'about', moduleId: './about', title: 'About' },
    ]);
    this.router = router;
  }
}
