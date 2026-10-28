import { Routes } from '@angular/router';
import { confirmLeaveGuard } from './core/guards/leave.guard';
import { profileGuard } from './core/guards/profile.guard';

export const routes: Routes = [
  {
    path: '',
    title: 'Roll&Run · El dado decide tu destino',
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  {
    path: 'crear',
    title: 'Configurar sala · Roll&Run',
    canActivate: [profileGuard],
    loadComponent: () => import('./features/create-room/create-room').then((m) => m.CreateRoom),
  },
  {
    path: 'unirse',
    title: 'Unirse a sala · Roll&Run',
    loadComponent: () => import('./features/join-room/join-room').then((m) => m.JoinRoom),
  },
  {
    path: 'unirse/:code',
    title: 'Unirse a sala · Roll&Run',
    loadComponent: () => import('./features/join-room/join-room').then((m) => m.JoinRoom),
  },
  {
    path: 'sala/:code',
    title: 'Sala · Roll&Run',
    loadComponent: () => import('./features/room/room').then((m) => m.Room),
    canDeactivate: [confirmLeaveGuard],
  },
  {
    path: '**',
    redirectTo: '',
  },
];
