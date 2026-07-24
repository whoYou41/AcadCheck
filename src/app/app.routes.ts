import { Routes } from '@angular/router';
import { adminGuard } from './guards/admin.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full',
  },
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'register',
    loadComponent: () => import('./pages/register/register.page').then((m) => m.RegisterPage),
  },
  {
    path: 'students',
    loadComponent: () => import('./pages/students/students.page').then((m) => m.StudentsPage),
  },
  {
    path: 'answer-key',
    loadComponent: () => import('./pages/answer-key/answer-key.page').then((m) => m.AnswerKeyPage),
  },
  {
    path: 'scanner',
    loadComponent: () => import('./pages/scanner/scanner.page').then((m) => m.ScannerPage),
  },
  {
    path: 'dashboard',
    loadComponent: () => import('./pages/dashboard/dashboard.page').then((m) => m.DashboardPage),
    canActivate: [adminGuard],
  },
  {
    path: 'results',
    loadComponent: () => import('./pages/results/results.page').then((m) => m.ResultsPage),
  },
  {
    path: 'records',
    loadComponent: () => import('./pages/records/records.page').then((m) => m.RecordsPage),
  },
  {
    path: 'profile',
    loadComponent: () => import('./pages/profile/profile.page').then((m) => m.ProfilePage),
  },
  {
    path: 'admin',
    loadComponent: () => import('./pages/admin/admin.page').then((m) => m.AdminPage),
    canActivate: [adminGuard],
  },
];
