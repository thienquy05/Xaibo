#!/usr/bin/perl
# P0-T05 supervisor: runs one command in its own process group and stops that whole group afterwards,
# never signalling anything outside it. Usage: perl supervise.pl <run-token> <pids-file> -- <cmd...>
# The supervisor stays outside the group; both sides call setpgid (race-free idiom). The leader is not reaped
# until group signalling ends, so its zombie keeps the group ID reserved. Exit: the command's status;
# 125 survivors (processes outside the group still holding the run's marker fd); 126 setup refused; 127 exec failed;
# 124 unkillable. Escape detection (macOS shows no other process's environment to a normal user, so an env token
# cannot be scanned): (1) every 50 ms poll records each process whose parent chain reaches the command or whose
# group is the command's (pid + start time); any still alive after shutdown is a survivor; (2) the command inherits
# an fd on a per-run marker file and `lsof` lists holders (Node-spawned children do not inherit it, hence (1)).
# Limit: a descendant that detaches from both the tree and the group within one poll gap (double fork) and holds no
# marker fd is not seen; the block backstop (in-profile.ts block-end) lists it. ps or lsof failures fail closed.
use strict;
use warnings;
use POSIX qw(setpgid _exit);
use Fcntl qw(F_SETFD);
use Time::HiRes qw(time);

my $TERM_GRACE_S = 5;
my $KILL_WAIT_S = 5;
my $POLL_S = 0.05;

my ($token, $pids_file, $sep, @cmd) = @ARGV;
die "usage: supervise.pl <token> <pids-file> -- <cmd...>\n" unless defined $sep && $sep eq '--' && @cmd;
my $hook = $ENV{XAIBO_SUPERVISE_TEST} // '';  # test-only fault injection
my $tty = -t STDIN;
my $stop = 0;
$SIG{$_} = sub { $stop = 1 } for qw(TERM INT HUP);

my ($child, $pg, %tree);  # %tree: descendant pid => start time
sub nap { select(undef, undef, undef, $POLL_S) }
sub lstart_of { my $l = `/bin/ps -o lstart= -p $_[0] 2>/dev/null` // ''; $l =~ s/^\s+|\s+$//g; return $l }
sub ps_rows {
  my $o = `/bin/ps -A -o pid=,ppid=,pgid=,stat=`;
  return undef if !defined $o || $? != 0;
  return [ grep { @$_ == 4 } map { [split ' '] } split /\n/, $o ];
}
# ponytail: seeds include recorded pids that may have exited; a reused pid's children could be counted (rare, fails closed)
sub track {
  my ($rows) = @_;
  my %known = map { $_ => 1 } ($child, keys %tree);
  for (my $added = 1; $added;) {
    $added = 0;
    for my $r (@$rows) {
      my ($p, $pp, $g) = @$r;
      next if $known{$p} || $p == $$ || !($known{$pp} || $g == $pg);
      $known{$p} = 1;
      $added = 1;
      my $ls = lstart_of($p);
      $tree{$p} = $ls if $ls ne '';
    }
  }
}
sub pgid_of { my $p = `/bin/ps -o pgid= -p $_[0] 2>/dev/null`; $p =~ s/\s+//g; return $p }
sub live_members {
  my $rows = ps_rows() or return ('unknown');  # cannot confirm empty: keep waiting, escalate, fail closed
  track($rows);
  return grep { $_->[2] == $pg && $_->[3] !~ /^Z/ } @$rows;
}
sub holders {
  open my $l, '-|', '/usr/sbin/lsof', '-t', '--', $_[0] or return (0);
  my @p = grep { /^\d+$/ } map { s/\s+//gr } <$l>;
  close $l;
  my $code = $? >> 8;
  return ($code == 0 || $code == 1, @p);  # lsof exits 1 when nothing holds the file
}
sub give_tty { my ($pg) = @_; return unless $tty; local $SIG{TTOU} = 'IGNORE'; POSIX::tcsetpgrp(0, $pg) }

# Outside the repo: the harness-os VM mounts the repo and holds handles on new files there (would read as a survivor).
my $marker = ($ENV{TMPDIR} // '/tmp') =~ s{/$}{}r . "/xaibo-run-$token-$$.marker";
open my $mfh, '>', $marker or die "marker: $!\n";
fcntl($mfh, F_SETFD, 0) or die "marker fd: $!\n";  # inherited across exec by the whole tree
pipe(my $r, my $w) or die "pipe: $!\n";
$child = fork() // die "fork: $!\n";
if ($child == 0) {
  close $r;
  $SIG{$_} = 'DEFAULT' for qw(TERM INT HUP);
  if ($hook eq 'child-setpgid-fail' || !setpgid(0, 0)) { print $w "setpgid\n"; close $w; _exit(126) }
  give_tty($$);
  { no warnings 'exec'; exec { $cmd[0] } @cmd; }
  print $w "exec\n"; close $w; _exit(127);
}
close $w;
close $mfh;
select(undef, undef, undef, 0.3) if $hook eq 'parent-delay';
setpgid($child, $child);  # EACCES after the child exec'd is the expected macOS race; verified below
my $failed = <$r>;
close $r;
$pg = $child;
my $group_ok = !defined $failed && pgid_of($child) eq "$child" && $hook ne 'group-check-fail';

sub stop_group {
  my ($sig_first) = @_;
  kill $sig_first, -$pg;
  my $term_deadline = time + $TERM_GRACE_S;
  my $kill_deadline;
  while (live_members($pg)) {
    if (!$kill_deadline && time >= $term_deadline) { kill 'KILL', -$pg; $kill_deadline = time + $KILL_WAIT_S }
    return 0 if $kill_deadline && time >= $kill_deadline;
    nap();
  }
  return 1;
}

if (!$group_ok) {
  stop_group('KILL') if pgid_of($child) eq "$child";
  waitpid($child, 0);
  unlink $marker;
  my $code = defined $failed && $failed =~ /^exec/ ? 127 : 126;
  print STDERR "in-profile: refused (" . ($code == 127 ? 'exec failed' : 'process group setup') . ")\n";
  exit $code;
}

my $lstart = `/bin/ps -o lstart= -p $$`;
chomp $lstart;
$lstart =~ s/^\s+//;
open my $pf, '>>', $pids_file or die "pids file: $!\n";
print $pf join("\t", $$, $lstart, $pg, join(' ', @cmd)), "\n";
close $pf;
give_tty($pg);

until ($stop) {
  my $rows = ps_rows();
  if ($rows) {
    track($rows);
    my ($leader) = grep { $_->[0] == $child } @$rows;
    last if !$leader || $leader->[3] =~ /^Z/;
  }
  nap();
}
my $stopped = stop_group('TERM');
give_tty(getpgrp());
waitpid($child, 0);
my $status = $?;
unless ($stopped) { print STDERR "in-profile: group members did not exit after KILL\n"; exit 124 }

my ($lsof_ok, @held) = holders($marker);
unlink $marker;
unless ($lsof_ok) { print STDERR "in-profile: survivor check failed\n"; exit 125 }
my %alive = map { $_ => 1 } @held, grep { my $l = lstart_of($_); $l ne '' && $l eq $tree{$_} } keys %tree;
my @survivors = keys %alive;
if (@survivors) { print STDERR "in-profile: survivors " . scalar(@survivors) . "\n"; exit 125 }
exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
